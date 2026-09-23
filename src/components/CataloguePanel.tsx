import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type ModelIndex,
} from '../lib/catalog/catalog';
import { fetchCatalogAsset, CatalogCorsError } from '../lib/catalog/fetch';
import { loadCatalogModel } from '../lib/catalog/load';
import { loadIdcCase, loadImportedCase } from '../lib/catalog/case-loader';
import { IMPORTED_DATASET } from '../lib/catalog/imported-cases';
import { cacheModel, loadCachedModel } from '../lib/fs/opfs';
import { useAppStore } from '../lib/state/store';
import { useBenchmarkStore } from '../lib/state/benchmarkStore';
import { useCatalogStore } from '../lib/state/catalogStore';
import { CatalogBatchPanel } from './CatalogBatchPanel';
import { CatalogImportPanel } from './CatalogImportPanel';
import { MaskCompareGrid } from './MaskCompareGrid';
import { addLocalModel, findLocalModel, localModelIds, pairModelFiles } from '../lib/catalog/local-models';
import { detectSourceFormat, asBytes } from '../types';
import { Button } from './ui/Button';
import { ExternalLink } from './ExternalLink';
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

  const models = useCatalogStore((s) => s.models);
  const setModels = useCatalogStore((s) => s.setModels);
  const [indexSource, setIndexSource] = useState<string | null>(null);
  const [index, setIndex] = useState<ModelIndex | null>(null);
  const importedCases = useCatalogStore((s) => s.importedCases);
  const removeImportedModel = useCatalogStore((s) => s.removeImportedModel);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string; url?: string } | null>(null);
  const datasetId = useCatalogStore((s) => s.datasetId);
  const setDatasetId = useCatalogStore((s) => s.setDatasetId);
  const batchRunning = useCatalogStore((s) => s.batchRunning);
  const datasets = useMemo(() => [...CATALOG_DATASETS, IMPORTED_DATASET], []);
  const dataset = useMemo<CatalogDataset>(() => datasets.find((d) => d.id === datasetId) ?? datasets[0]!, [datasets, datasetId]);
  const cases: Array<{ caseId: string; description?: string }> =
    dataset.access.kind === 'idc-s3' ? dataset.access.cases : dataset.access.kind === 'imported' ? importedCases : [];
  const [caseId, setCaseId] = useState<string>('');
  const theCase = cases.find((c) => c.caseId === caseId) ?? cases[0];

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
          setIndex(idx);
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
  }, [setModels]);

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
          findLocal: (id) => findLocalModel(id),
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
      const viewer = viewerRef.current;
      const idc = dataset.access.kind === 'idc-s3' ? dataset.access.cases.find((c) => c.caseId === theCase.caseId) : undefined;
      const imported = importedCases.find((c) => c.caseId === theCase.caseId);
      const lc = idc
        ? await loadIdcCase(viewer, idc, setProgress)
        : imported && dataset.access.kind === 'imported'
          ? await loadImportedCase(viewer, imported, setProgress)
          : null;
      if (!lc) throw new Error(`Unknown case ${theCase.caseId}.`);
      const meta = lc.meta;
      const mapped = lc.reference;
      setVolume({
        source: {
          name: `${dataset.name} · ${theCase.caseId}`,
          bytes: lc.firstFile.bytes,
          hint: `catalog:${dataset.id}/${theCase.caseId}`,
        },
        voxels: lc.voxels,
        meta,
        sourceFormat: detectSourceFormat(lc.firstFile.name),
      });
      setReference({
        source: 'volume',
        label: `${dataset.id}/${theCase.caseId} GT (1 liver, 2 tumour)`,
        mask: mapped.mask,
        dims: mapped.dims,
        spacing: meta.spacing,
        catalog: { datasetId: dataset.id, caseId: theCase.caseId, labelSpace: 'liver-tumour' as const },
      });
      let overlayWarning = '';
      try {
        await viewer.addMaskOverlay('ground truth', mapped.mask, mapped.dims, meta.spacing, 'green', 0.4, {
          srowX: meta.srowX,
          srowY: meta.srowY,
          srowZ: meta.srowZ,
        });
      } catch (e) {
        // The reference is still set for scoring; only the display failed.
        overlayWarning = ` (GT overlay could not be drawn: ${(e as Error).message})`;
      }
      setNotice(`Loaded ${theCase.caseId}: ${lc.note}. GT set as the Benchmark reference.` + overlayWarning);
    } catch (e) {
      fail(e);
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }, [theCase, viewerRef, dataset, importedCases, setVolume, setReference, fail]);

  const [localIds, setLocalIds] = useState<string[]>(() => localModelIds());
  const addRef = useRef<HTMLInputElement>(null);
  async function onAddLocal(files: File[]) {
    if (!files.length) return;
    setError(null);
    const pairs = pairModelFiles(files);
    if (!pairs.length) {
      setError({ msg: 'Pick each model as a pair: <id>.onnx + <id>.json from the zenodo-models-v1 release (e.g. lms3d_unet.onnx + lms3d_unet.json).' });
      return;
    }
    setBusy('add-local');
    try {
      for (const p of pairs) {
        setProgress(`Caching ${p.id}…`);
        await addLocalModel(p.id, asBytes(new Uint8Array(await p.onnx.arrayBuffer())), await p.json.text());
      }
      setLocalIds(localModelIds());
      setNotice(`Added ${pairs.length} model(s) from disk: ${pairs.map((p) => p.id).join(', ')}.`);
    } catch (e) {
      fail(e);
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }

  const statusBadge = (m: CatalogModel) =>
    localIds.includes(m.id) ? (
      <Badge variant="accent" className="text-[10px]">on this device</Badge>
    ) :
    m.status === 'ok' ? (
      <Badge variant="ok" className="text-[10px]" title="Full published weights, fp32 ONNX, parity-checked vs PyTorch">
        {m.imported ? (m.imported.via === 'onnx' ? 'Zenodo ONNX' : 'verified export') : 'full weights · ONNX'}
      </Badge>
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
        Published liver-CT models from Zenodo as their full published weights — fp32 ONNX exports of the original
        checkpoints, parity-checked against PyTorch (not demos or reduced models) — and public datasets pulled straight
        from TCIA. Load a case + a model, run inference, score in Benchmark; or import your own below.
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
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.access.kind === 'imported' ? `${d.name} — ${importedCases.length} imported` : `${d.name} — ${d.subjects} subjects · ${d.license}`}
            </option>
          ))}
        </select>
        <p className="text-[10px] leading-tight text-slate-500">{dataset.description}</p>
        {dataset.access.kind === 'imported' && cases.length === 0 ? (
          <p className="text-[10px] text-slate-500">No imported cases yet — add a DICOM folder or IDC series under “Import your own” below.</p>
        ) : dataset.access.kind === 'idc-s3' || dataset.access.kind === 'imported' ? (
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
            <Button size="sm" onClick={onLoadCase} disabled={!theCase || busy !== null || batchRunning} className="gap-1">
              {busy === 'case' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Target className="h-3.5 w-3.5" />}
              Load CT + GT
            </Button>
          </div>
        ) : (
          <ExternalLink href={dataset.access.url} className="inline-flex items-center gap-1 text-[11px] text-blue-700 underline">
            <Download className="h-3 w-3" /> {mb(dataset.access.sizeBytes)} archive — {dataset.access.note}
          </ExternalLink>
        )}
        <div className="text-[10px] text-slate-400">
          <ExternalLink className="underline" href={dataset.pageUrl}>
            {dataset.pageUrl.replace(/^https?:\/\//, '')}
          </ExternalLink>{' '}
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
        <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
          <span>Browser build can't reach the release host? Download the files, then add them here once.</span>
          <input
            ref={addRef}
            type="file"
            multiple
            accept=".onnx,.json"
            className="hidden"
            data-testid="catalog-add-local"
            onChange={(e) => {
              // Copy before resetting: clearing value empties the live FileList.
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              void onAddLocal(files);
            }}
          />
          <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => addRef.current?.click()} disabled={busy !== null}>
            Add downloaded models
          </Button>
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
                  disabled={busy !== null || batchRunning || m.status === 'failed'}
                  className="h-6 gap-1 px-2 text-[11px]"
                >
                  {busy === `model:${m.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  Load
                </Button>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                {m.kind !== 'unknown' && <span>{m.kind === 'cnn' ? 'CNN' : 'Transformer'}</span>}
                <span>{mb(m.bytes)} fp32</span>
                {m.trainedOn.length > 0 && <span>trained: {m.trainedOn.join(', ')}</span>}
                {m.imported && <span title={m.imported.note}>imported: {m.imported.note}</span>}
                <span>test on: {datasetsForModel(m).map((d) => d.name).join(' · ')}</span>
                {m.parity && <span>parity Δ {m.parity.maxAbsDiff.toExponential(1)}</span>}
                <ExternalLink className="inline-flex items-center gap-0.5 underline" href={m.zenodoUrl}>
                  Zenodo <ExtIcon className="h-2.5 w-2.5" />
                </ExternalLink>
                <span title={m.citation}>{m.license}</span>
                {m.imported && (
                  <button type="button" className="underline" onClick={() => removeImportedModel(m.id)} aria-label={`Remove imported model ${m.name}`}>
                    remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <CatalogImportPanel index={index} disabled={batchRunning} />

      <CatalogBatchPanel viewerRef={viewerRef} />

      <section className="rounded border border-slate-200 p-2 dark:border-slate-700">
        <MaskCompareGrid size={96} />
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
              <ExternalLink className="underline" href={error.url}>
                Download manually
              </ExternalLink>
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
