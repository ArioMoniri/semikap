/**
 * Catalogue → Batch benchmark. Pick cases (TCIA/IDC dataset, or your own NIfTI
 * CT + label pairs) and models; TAMIAS downloads, runs, scores and records
 * every (case, model) pair, fills the comparison statistics and the mask
 * comparison grid. Everything runs on this device.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { ListChecks, Play, Square, FolderOpen } from 'lucide-react';
import { CATALOG_DATASETS, type CatalogModel } from '../lib/catalog/catalog';
import { runCatalogBatch, type BatchCase } from '../lib/catalog/batch';
import { loadIdcCase, loadLocalNiftiCase, pairLocalFiles, type LoadedCase } from '../lib/catalog/case-loader';
import { loadCatalogModel } from '../lib/catalog/load';
import { findLocalModel } from '../lib/catalog/local-models';
import { fetchCatalogAsset } from '../lib/catalog/fetch';
import { cacheModel, loadCachedModel } from '../lib/fs/opfs';
import { canonicalGroupMasks, groupsForModelLabels } from '../lib/metrics/label-groups';
import { scoreSegmentation } from '../lib/metrics/score';
import { buildKeySlice, toRadiological, toRadiologicalCt } from '../lib/benchmark/mask-compare';
import { appendRecord } from '../lib/benchmark/store';
import { captureEnv } from '../lib/benchmark/env';
import type { BenchmarkRecord } from '../lib/benchmark/types';
import { useCatalogStore } from '../lib/state/catalogStore';
import { useBenchmarkStore } from '../lib/state/benchmarkStore';
import { useAppStore, type ModelRecord } from '../lib/state/store';
import type { InferenceApi, InferenceProgressEvent } from '../workers/inference.worker';
import { detectSourceFormat } from '../types';
import { Button } from './ui/Button';
import type { ViewerHandle } from './Viewer';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

const short = (n: string) => n.replace(/^LightningMedSeg3D /, '').replace(/ \(.*\)$/, '');

export function CatalogBatchPanel({ viewerRef }: Props) {
  const models = useCatalogStore((s) => s.models);
  const datasetId = useCatalogStore((s) => s.datasetId);
  const selectedCases = useCatalogStore((s) => s.selectedCases);
  const setSelectedCases = useCatalogStore((s) => s.setSelectedCases);
  const selectedModels = useCatalogStore((s) => s.selectedModels);
  const setSelectedModels = useCatalogStore((s) => s.setSelectedModels);
  const activeKit = useCatalogStore((s) => s.activeKit);
  const kitNonce = useCatalogStore((s) => s.kitNonce);
  const putKeySlice = useCatalogStore((s) => s.putKeySlice);
  const profileId = useBenchmarkStore((s) => s.currentProfileId);
  const addRecord = useBenchmarkStore((s) => s.addRecord);
  const setReference = useBenchmarkStore((s) => s.setReference);
  const setVolume = useAppStore((s) => s.setVolume);
  const backend = useAppStore((s) => s.backend);

  const dataset = CATALOG_DATASETS.find((d) => d.id === datasetId) ?? CATALOG_DATASETS[0]!;
  const idcCases = dataset.access.kind === 'idc-s3' ? dataset.access.cases : [];
  const [localPairs, setLocalPairs] = useState<ReturnType<typeof pairLocalFiles>>([]);
  const ctRef = useRef<HTMLInputElement>(null);
  const lbRef = useRef<HTMLInputElement>(null);
  const [ctFiles, setCtFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Array<{ caseId: string; model: string; dice: number; tumour?: number; s: number }>>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const signal = useRef({ aborted: false });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (kitNonce) rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [kitNonce]);

  const caseChoices: string[] = dataset.access.kind === 'idc-s3' ? idcCases.map((c) => c.caseId) : localPairs.map((p) => p.caseId);
  const runnable = models.filter((m) => m.status !== 'failed');
  const chosenModels = useMemo(() => runnable.filter((m) => selectedModels.includes(m.id)), [runnable, selectedModels]);
  const chosenCases = caseChoices.filter((c) => selectedCases.includes(c));

  const toggle = (list: string[], id: string, set: (v: string[]) => void) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  async function run() {
    if (!viewerRef.current || !profileId) return;
    const viewer = viewerRef.current;
    signal.current = { aborted: false };
    setRunning(true);
    setFailures([]);
    setResults([]);
    const worker = new Worker(new URL('../workers/inference.worker.ts', import.meta.url), { type: 'module' });
    const api = Comlink.wrap<InferenceApi>(worker);
    const byCase = new Map<string, LoadedCase>();
    try {
      const cases: BatchCase[] = chosenCases.map((caseId) => ({ datasetId: dataset.id, caseId }));
      const summary = await runCatalogBatch<LoadedCase, { catalog: CatalogModel; rec: ModelRecord }>(
        cases,
        chosenModels.map((m) => ({ id: m.id, name: m.name })),
        {
          signal: signal.current,
          onProgress: (p) =>
            setStatus(
              `${p.done}/${p.total} · ${p.caseId}${p.modelId ? ` · ${short(models.find((m) => m.id === p.modelId)?.name ?? p.modelId)}` : ''} · ${p.stage}…`
            ),
          loadCase: async (c) => {
            byCase.clear(); // one decoded case in memory at a time
            let lc: LoadedCase;
            if (dataset.access.kind === 'idc-s3') {
              const idc = idcCases.find((x) => x.caseId === c.caseId)!;
              lc = await loadIdcCase(viewer, idc, (m) => setStatus(`${c.caseId} · ${m}`));
            } else {
              const pair = localPairs.find((p) => p.caseId === c.caseId)!;
              lc = await loadLocalNiftiCase(viewer, pair.ct, pair.label);
            }
            setVolume({
              source: { name: `${dataset.name} · ${c.caseId}`, bytes: lc.firstFile.bytes, hint: `catalog:${dataset.id}/${c.caseId}` },
              voxels: lc.voxels,
              meta: lc.meta,
              sourceFormat: detectSourceFormat(lc.firstFile.name),
            });
            setReference({
              source: 'volume',
              label: `${dataset.id}/${c.caseId} GT (1 liver, 2 tumour)`,
              ...lc.reference,
              catalog: { datasetId: dataset.id, caseId: c.caseId, labelSpace: 'liver-tumour' },
            });
            byCase.set(c.caseId, lc);
            return { volume: lc, reference: lc.reference };
          },
          loadModel: async (m) => {
            const catalog = models.find((x) => x.id === m.id)!;
            const rec = await loadCatalogModel(catalog, {
              fetchAsset: (url, o) => fetchCatalogAsset(url, o),
              cache: (bytes, manifest) => cacheModel(bytes, manifest),
              findCached: async (h) => (await loadCachedModel(h))?.bytes ?? null,
              findLocal: (id) => findLocalModel(id),
            });
            return { catalog, rec };
          },
          infer: async (lc, m) => {
            const noop = Comlink.proxy((_e: InferenceProgressEvent) => {});
            const res = await api.run(
              {
                voxels: lc.voxels,
                dims: lc.meta.dims,
                spacing: lc.meta.spacing,
                origin: lc.meta.origin,
                modelBytes: m.rec.bytes,
                manifest: m.rec.manifest,
                srowX: lc.meta.srowX,
                srowY: lc.meta.srowY,
                srowZ: lc.meta.srowZ,
              },
              noop
            );
            return { mask: res.mask, dims: res.dims, spacing: res.spacing, elapsedMs: res.elapsedMs, provider: res.provider };
          },
          score: async (ref, pred, m) => {
            const groups = canonicalGroupMasks(ref.mask, pred.mask, m.rec.manifest.output.labels);
            return groups.map((g) => {
              const r = scoreSegmentation({
                refMask: g.ref,
                refGrid: { dims: ref.dims, spacing: ref.spacing },
                predMask: g.pred,
                predGrid: { dims: pred.dims, spacing: pred.spacing },
                labels: [1],
              });
              return { ...r.perLabel[0]!, label: g.id };
            });
          },
          onResult: async (r) => {
            const whole = r.metrics.find((x) => x.label === 1);
            const tumour = r.metrics.find((x) => x.label === 2);
            const record: BenchmarkRecord = {
              schema: 'tamias.benchmark.v1',
              id: crypto.randomUUID(),
              profileId,
              datasetName: r.case.datasetId,
              task: 'segmentation',
              model: { name: r.loadedModel.rec.manifest.name, version: r.loadedModel.rec.manifest.version, sha256: r.loadedModel.rec.hash },
              case: {
                caseId: r.case.caseId,
                imageName: `${r.case.datasetId}/${r.case.caseId}`,
                referenceName: `${r.case.datasetId}/${r.case.caseId} GT (1 whole liver, 2 tumour)`,
                meta: { modality: 'CT', bodyPart: 'LIVER', contrast: true },
              },
              runtime: { provider: r.prediction.provider, inferMs: r.prediction.elapsedMs, totalMs: r.prediction.elapsedMs },
              segmentation: r.metrics,
              env: captureEnv(backend, __APP_VERSION__),
              createdAt: new Date().toISOString(),
              appVersion: __APP_VERSION__,
            };
            await appendRecord(profileId, record);
            addRecord(record);
            // Key slice for the mask comparison grid (radiological orientation).
            const lc = r.volume;
            const affine = { srowX: lc.meta.srowX, srowY: lc.meta.srowY, srowZ: lc.meta.srowZ };
            const ct = toRadiologicalCt(lc.voxels, lc.meta.dims, affine);
            const gt = toRadiological(lc.reference.mask, lc.reference.dims, affine);
            const pr = toRadiological(r.prediction.mask, r.prediction.dims, affine);
            const liverLabels = groupsForModelLabels(r.loadedModel.rec.manifest.output.labels)[0]!.predMembers;
            const ks = buildKeySlice({
              caseKey: `${r.case.datasetId}/${r.case.caseId}`,
              ct: ct.data,
              reference: gt.data,
              dims: gt.dims,
              predictions: [{ model: r.loadedModel.rec.manifest.name, mask: pr.data, liverLabels, dice: whole?.dice }],
            });
            const { preds, ...base } = ks;
            putKeySlice(base, preds[0]);
            setResults((prev) => [
              ...prev,
              { caseId: r.case.caseId, model: short(r.model.name), dice: whole?.dice ?? NaN, tumour: tumour?.dice, s: r.prediction.elapsedMs / 1000 },
            ]);
          },
        }
      );
      setFailures(summary.failed.map((f) => `${f.caseId}${f.modelId ? ` × ${f.modelId}` : ''}: ${f.error}`));
      setStatus(
        `${summary.cancelled ? 'Cancelled' : 'Done'} — ${summary.completed} scored, ${summary.failed.length} failed. ` +
          'Open Benchmark → comparison → Full report for statistics and mask comparison.'
      );
    } catch (e) {
      setStatus(`Batch failed: ${(e as Error).message}`);
    } finally {
      worker.terminate();
      setRunning(false);
    }
  }

  return (
    <section ref={rootRef} className="space-y-2 rounded border border-slate-200 p-2 dark:border-slate-700" data-testid="catalog-batch">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <ListChecks className="h-3.5 w-3.5" /> Batch benchmark
        </span>
        {activeKit && <span className="text-[10px] text-slate-400">kit: {activeKit}</span>}
      </div>
      <p className="text-[10px] leading-tight text-slate-500">
        Every selected model runs on every selected case of <b>{dataset.name}</b>; each prediction is scored against the ground truth (whole liver
        + tumour) and recorded. Results feed Benchmark → comparison statistics and the mask comparison grid.
      </p>

      {dataset.access.kind === 'idc-s3' ? (
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium">
            <span>Cases ({chosenCases.length}/{caseChoices.length})</span>
            <span className="space-x-2">
              <button type="button" className="underline" onClick={() => setSelectedCases(caseChoices)}>
                all
              </button>
              <button type="button" className="underline" onClick={() => setSelectedCases([])}>
                none
              </button>
            </span>
          </div>
          <div className="grid grid-cols-3 gap-x-2 text-[11px]">
            {caseChoices.map((c) => (
              <label key={c} className="flex items-center gap-1">
                <input type="checkbox" checked={selectedCases.includes(c)} onChange={() => toggle(selectedCases, c, setSelectedCases)} />
                {c}
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-1 text-[11px]">
          <div className="font-medium">Local NIfTI cases — CT + label map (1 liver, 2 tumour), paired by file name</div>
          <input ref={ctRef} type="file" multiple accept=".nii,.gz" className="hidden" data-testid="batch-ct-input" onChange={(e) => setCtFiles(Array.from(e.currentTarget.files ?? []))} />
          <input
            ref={lbRef}
            type="file"
            multiple
            accept=".nii,.gz"
            className="hidden"
            data-testid="batch-label-input"
            onChange={(e) => {
              const pairs = pairLocalFiles(ctFiles, Array.from(e.currentTarget.files ?? []));
              setLocalPairs(pairs);
              setSelectedCases(pairs.map((p) => p.caseId));
            }}
          />
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => ctRef.current?.click()}>
              <FolderOpen className="h-3 w-3" /> CT files ({ctFiles.length})
            </Button>
            <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => lbRef.current?.click()} disabled={!ctFiles.length}>
              <FolderOpen className="h-3 w-3" /> Label files
            </Button>
          </div>
          {localPairs.length > 0 && <div className="text-slate-500">{localPairs.length} paired cases: {localPairs.map((p) => p.caseId).join(', ')}</div>}
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] font-medium">
          <span>Models ({chosenModels.length}/{runnable.length})</span>
          <span className="space-x-2">
            <button type="button" className="underline" onClick={() => setSelectedModels(runnable.map((m) => m.id))}>
              all
            </button>
            <button type="button" className="underline" onClick={() => setSelectedModels([])}>
              none
            </button>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-2 text-[11px]">
          {runnable.map((m) => (
            <label key={m.id} className="flex items-center gap-1" title={m.name}>
              <input type="checkbox" checked={selectedModels.includes(m.id)} onChange={() => toggle(selectedModels, m.id, setSelectedModels)} />
              <span className="truncate">{short(m.name)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" className="gap-1" disabled={running || !chosenCases.length || !chosenModels.length} onClick={() => void run()} data-testid="batch-run">
          <Play className="h-3.5 w-3.5" /> Run {chosenCases.length * chosenModels.length} runs
        </Button>
        {running && (
          <Button size="sm" variant="outline" className="gap-1" onClick={() => (signal.current.aborted = true)}>
            <Square className="h-3.5 w-3.5" /> Stop after current
          </Button>
        )}
      </div>
      {status && <p className="text-[11px] text-slate-600 dark:text-slate-300" data-testid="batch-status">{status}</p>}
      {results.length > 0 && (
        <table className="w-full text-[10px]">
          <thead className="text-slate-500">
            <tr className="text-left">
              <th>Case</th>
              <th>Model</th>
              <th>Liver Dice</th>
              <th>Tumour Dice</th>
              <th>s</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {results.map((r, i) => (
              <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                <td>{r.caseId}</td>
                <td>{r.model}</td>
                <td>{r.dice.toFixed(3)}</td>
                <td>{r.tumour !== undefined ? r.tumour.toFixed(3) : '—'}</td>
                <td>{r.s.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {failures.length > 0 && (
        <details className="text-[10px] text-red-700">
          <summary>{failures.length} failed</summary>
          <ul>
            {failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
