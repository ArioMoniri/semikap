import { useCallback, useEffect, useMemo, useState } from 'react';
import { Library, Download, Loader2, ExternalLink as ExtIcon, Database, Brain, Target } from 'lucide-react';
import {
  CATALOG_DATASETS,
  CATALOG_MODELS,
  MODEL_INDEX_URLS,
  mergeModelIndex,
  parseModelIndex,
  datasetsForModel,
  type CatalogModel,
  type CatalogDataset,
  type IdcCase,
} from '../lib/catalog/catalog';
import { fetchCatalogAsset, CatalogCorsError } from '../lib/catalog/fetch';
import { listIdcSeriesUrls } from '../lib/catalog/idc';
import { loadCatalogModel, fetchIdcSeriesFiles } from '../lib/catalog/load';
import { cacheModel, loadCachedModel } from '../lib/fs/opfs';
import { mapSegFramesToGrid, parseDicomSegGeometry, classifySegment } from '../lib/datasets/seg-to-grid';
import { useAppStore } from '../lib/state/store';
import { useBenchmarkStore } from '../lib/state/benchmarkStore';
import { detectSourceFormat } from '../types';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import type { ViewerHandle } from './Viewer';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

function mb(n?: number): string {
  return n ? `${(n / 1e6).toFixed(n > 1e7 ? 0 : 1)} MB` : '—';
}

/**
 * Model & Dataset Catalogue — pick a published model (Zenodo → ONNX) and a
 * public dataset case (HCC-TACE-Seg straight from TCIA/IDC), load both, then
 * run + score in the Benchmark panel. The ground-truth DICOM-SEG is mapped
 * onto the CT grid and set as the benchmark reference automatically.
 */
export function CataloguePanel({ viewerRef }: Props) {
  const setVolume = useAppStore((s) => s.setVolume);
  const setModel = useAppStore((s) => s.setModel);
  const pushError = useAppStore((s) => s.pushError);
  const volume = useAppStore((s) => s.volume);
  const setReference = useBenchmarkStore((s) => s.setReference);

  const [models, setModels] = useState<CatalogModel[]>([...CATALOG_MODELS]);
  const [indexSource, setIndexSource] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string; url?: string } | null>(null);
  const [datasetId, setDatasetId] = useState(CATALOG_DATASETS[0]!.id);
  const dataset = useMemo<CatalogDataset>(
    () => CATALOG_DATASETS.find((d) => d.id === datasetId) ?? CATALOG_DATASETS[0]!,
    [datasetId]
  );
  const cases = dataset.access.kind === 'idc-s3' ? dataset.access.cases : [];
  const [caseId, setCaseId] = useState<string>('');
  const theCase: IdcCase | undefined = cases.find((c) => c.caseId === caseId) ?? cases[0];

  // Load the release index (HF mirror first, GitHub release fallback).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const url of MODEL_INDEX_URLS) {
        try {
          const bytes = await fetchCatalogAsset(url);
          const idx = parseModelIndex(JSON.parse(new TextDecoder().decode(bytes)));
          if (cancelled) return;
          setModels(mergeModelIndex(CATALOG_MODELS, idx));
          setIndexSource(url);
          return;
        } catch {
          /* try next source */
        }
      }
      if (!cancelled) setIndexSource(null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = useCallback(
    (e: unknown) => {
      const err = e as Error;
      setError({ msg: err.message, url: e instanceof CatalogCorsError ? e.url : undefined });
      pushError(err.message);
    },
    [pushError]
  );

  const onLoadModel = useCallback(
    async (m: CatalogModel) => {
      setBusy(`model:${m.id}`);
      setError(null);
      setNotice(null);
      try {
        const rec = await loadCatalogModel(m, {
          fetchAsset: (url, o) => fetchCatalogAsset(url, o),
          cache: (bytes, manifest) => cacheModel(bytes, manifest),
          findCached: async (h) => (await loadCachedModel(h))?.bytes ?? null,
        });
        setModel(rec);
        setNotice(`Loaded ${m.name}. Run inference, then score it in Benchmark.`);
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [setModel, fail]
  );

  const onLoadCase = useCallback(async () => {
    if (!theCase || !viewerRef.current) return;
    setBusy('case');
    setError(null);
    setNotice(null);
    try {
      setProgress('Listing CT series on IDC…');
      const files = await fetchIdcSeriesFiles(theCase.ctSeriesUuid, {
        list: (uuid) => listIdcSeriesUrls(uuid),
        fetchAsset: (url) => fetchCatalogAsset(url),
        concurrency: 8,
        onProgress: (d, t) => setProgress(`CT ${d}/${t} slices`),
      });
      setProgress('Building volume…');
      const loaded = await viewerRef.current.loadPrimaryFromFiles(files);
      setVolume({
        source: {
          name: `${dataset.name} · ${theCase.caseId}`,
          bytes: files[0]!.bytes,
          hint: `catalog:${dataset.id}/${theCase.caseId}`,
        },
        voxels: loaded.voxels,
        meta: loaded.meta,
        sourceFormat: detectSourceFormat(files[0]!.name),
      });

      setProgress('Fetching ground-truth DICOM-SEG…');
      const segFiles = await fetchIdcSeriesFiles(theCase.segSeriesUuid, {
        list: (uuid) => listIdcSeriesUrls(uuid),
        fetchAsset: (url) => fetchCatalogAsset(url),
      });
      const seg = parseDicomSegGeometry(segFiles[0]!.bytes);
      const meta = loaded.meta;
      if (!meta.srowX || !meta.srowY || !meta.srowZ) {
        throw new Error('Viewer did not expose the CT affine; cannot place the ground truth.');
      }
      const mapped = mapSegFramesToGrid(
        seg,
        { dims: meta.dims, srowX: meta.srowX, srowY: meta.srowY, srowZ: meta.srowZ },
        (s) => classifySegment(seg.segments.get(s) ?? '')
      );
      setReference({
        source: 'volume',
        label: `${dataset.id}/${theCase.caseId} GT (1 liver, 2 tumour)`,
        mask: mapped.mask,
        dims: mapped.dims,
        spacing: meta.spacing,
      });
      viewerRef.current.addMaskOverlay('ground truth', mapped.mask, mapped.dims, meta.spacing, undefined, 0.35, {
        srowX: meta.srowX,
        srowY: meta.srowY,
        srowZ: meta.srowZ,
      });
      const segNames = [...seg.segments.values()].join(', ');
      setNotice(
        `Loaded ${theCase.caseId}: ${files.length} CT slices + GT (${segNames})` +
          (mapped.outOfGridFrames ? ` — ${mapped.outOfGridFrames} SEG frames outside the CT grid` : '') +
          '. GT set as the Benchmark reference.'
      );
    } catch (e) {
      fail(e);
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }, [theCase, viewerRef, dataset, setVolume, setReference, fail]);

  const statusBadge = (m: CatalogModel) =>
    m.status === 'ok' ? (
      <Badge variant="ok" className="text-[10px]">ONNX ready</Badge>
    ) : m.status === 'failed' ? (
      <Badge variant="warn" className="text-[10px]" title={m.error ?? ''}>export failed</Badge>
    ) : (
      <Badge variant="outline" className="text-[10px]">not verified</Badge>
    );

  return (
    <div className="space-y-3 text-xs" data-testid="catalogue-panel">
      <div className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">
        <Library className="h-4 w-4 text-tamias-accent" /> Model &amp; Dataset Catalogue
      </div>
      <p className="text-[11px] leading-snug text-slate-500">
        Published liver-CT models (Zenodo → ONNX) and public datasets pulled straight from TCIA. Load a
        case + a model, run inference, score in Benchmark; repeat per model to compare.
      </p>

      {/* ---------------- Datasets ---------------- */}
      <section className="space-y-1.5 rounded border border-slate-200 p-2 dark:border-slate-700">
        <div className="flex items-center gap-1.5 font-medium">
          <Database className="h-3.5 w-3.5" /> Dataset
        </div>
        <select
          aria-label="Dataset"
          value={datasetId}
          onChange={(e) => {
            setDatasetId(e.currentTarget.value);
            setCaseId('');
          }}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
        >
          {CATALOG_DATASETS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} — {d.subjects} subjects · {d.license}
            </option>
          ))}
        </select>
        <p className="text-[10px] leading-tight text-slate-500">{dataset.description}</p>
        {dataset.access.kind === 'idc-s3' ? (
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Case"
              value={theCase?.caseId ?? ''}
              onChange={(e) => setCaseId(e.currentTarget.value)}
              className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
            >
              {cases.map((c) => (
                <option key={c.caseId} value={c.caseId}>
                  {c.caseId}
                  {c.description ? ` — ${c.description}` : ''}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={onLoadCase} disabled={!theCase || busy !== null} className="gap-1">
              {busy === 'case' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Target className="h-3.5 w-3.5" />}
              Load CT + GT
            </Button>
          </div>
        ) : (
          <a
            href={dataset.access.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-blue-700 underline"
          >
            <Download className="h-3 w-3" /> {mb(dataset.access.sizeBytes)} archive — {dataset.access.note}
          </a>
        )}
        <div className="text-[10px] text-slate-400">
          <a className="underline" href={dataset.pageUrl} target="_blank" rel="noreferrer">
            {dataset.pageUrl.replace(/^https?:\/\//, '')}
          </a>{' '}
          · doi:{dataset.doi}
        </div>
      </section>

      {/* ---------------- Models ---------------- */}
      <section className="space-y-1.5 rounded border border-slate-200 p-2 dark:border-slate-700">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-medium">
            <Brain className="h-3.5 w-3.5" /> Models ({models.length})
          </span>
          <span className="text-[10px] text-slate-400">
            {indexSource ? (indexSource.includes('huggingface') ? 'index: HF mirror' : 'index: GitHub release') : 'index: offline'}
          </span>
        </div>
        <ul className="space-y-1">
          {models.map((m) => (
            <li
              key={m.id}
              data-testid={`catalog-model-${m.id}`}
              className="rounded border border-slate-200 bg-slate-50 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate font-medium" title={m.name}>
                  {m.name}
                </span>
                {statusBadge(m)}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onLoadModel(m)}
                  disabled={busy !== null || m.status === 'failed'}
                  className="h-6 gap-1 px-2 text-[11px]"
                >
                  {busy === `model:${m.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  Load
                </Button>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                <span>{m.kind === 'cnn' ? 'CNN' : 'Transformer'}</span>
                <span>{mb(m.bytes)}</span>
                <span>trained: {m.trainedOn.join(', ')}</span>
                <span>test on: {datasetsForModel(m).map((d) => d.name).join(' · ')}</span>
                {m.parity && <span>parity Δ {m.parity.maxAbsDiff.toExponential(1)}</span>}
                <a className="inline-flex items-center gap-0.5 underline" href={m.zenodoUrl} target="_blank" rel="noreferrer">
                  Zenodo <ExtIcon className="h-2.5 w-2.5" />
                </a>
                <span title={m.citation}>{m.license}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {progress && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
          <Loader2 className="h-3 w-3 animate-spin" /> {progress}
        </div>
      )}
      {notice && <div className="rounded bg-emerald-50 p-2 text-[11px] text-emerald-800">{notice}</div>}
      {error && (
        <div className="whitespace-pre-wrap rounded bg-red-50 p-2 text-[11px] text-red-700">
          {error.msg}
          {error.url && (
            <>
              {' '}
              <a className="underline" href={error.url} target="_blank" rel="noreferrer">
                Download manually
              </a>
            </>
          )}
        </div>
      )}
      {volume && (
        <p className="text-[10px] text-slate-400">
          Current image: {volume.source.name}
        </p>
      )}
    </div>
  );
}
