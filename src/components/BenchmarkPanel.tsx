/**
 * Benchmark panel — the per-user radiology benchmarking workspace.
 *
 * Flow (all local, no upload):
 *  1. Pick a profile in the header (👤) — gates the whole panel.
 *  2. Register ONNX models: the manifest is validated and the ONNX graph is
 *     structurally checked (opset / IO) before the model is added to *your*
 *     registry.
 *  3. Capture a reference: either the currently loaded volume (a ground-truth
 *     mask) or the current model output (to measure model-vs-model agreement).
 *  4. Run a model in the viewer as usual, then "Score" the current result
 *     against the reference — Dice / IoU / HD95 / ASSD / volume difference are
 *     computed by the metric engine and saved as a benchmark record.
 *  5. Compare models side-by-side and export CSV / JSON.
 */

import { useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { Plus, Trash2, Crosshair, Download, Play, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { useBenchmarkStore } from '../lib/state/benchmarkStore';
import { listRegistry, registerModel, removeModel, type RegistryEntry } from '../lib/registry/registry';
import { validateOnnx } from '../lib/registry/onnx-validate';
import { parseManifest } from '../lib/inference/manifest';
import { cacheModel, sha256Hex } from '../lib/fs/opfs';
import { scoreSegmentation, type ScoreInputs } from '../lib/metrics/score';
import type { MultiLabelResult } from '../lib/metrics/segmentation';
import type { MetricsApi } from '../workers/metrics.worker';
import { captureEnv } from '../lib/benchmark/env';
import { summarizeSegmentation, type BenchmarkRecord } from '../lib/benchmark/types';
import { recordsToCsv, recordsToJson } from '../lib/benchmark/export';
import { generateHtmlReport } from '../lib/benchmark/report';
import { appendRecord, listRecords, clearRecords } from '../lib/benchmark/store';
import { readNiftiMask } from '../lib/datasets/nifti-mask';
import { alignToPrediction } from '../lib/metrics/align';
import { diffVolume, maxDisagreementSlice, type DiffSlice } from '../lib/metrics/mask-diff';
import { MaskDiffCanvas } from './MaskDiffCanvas';
import { readDicomSeg } from '../lib/datasets/dicom-seg-import';
import { readRtStruct } from '../lib/datasets/rtstruct-import';
import { asBytes } from '../types';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { BenchmarkAnalysisPanel } from './BenchmarkAnalysisPanel';
import { BenchmarkGovernancePanel } from './BenchmarkGovernancePanel';
import { BenchmarkClassifyPanel } from './BenchmarkClassifyPanel';
import { BenchmarkDetectionPanel } from './BenchmarkDetectionPanel';
import { BenchmarkStatsPanel } from './BenchmarkStatsPanel';
import { BenchmarkComparePanel } from './BenchmarkComparePanel';
import { BenchmarkRocComparePanel } from './BenchmarkRocComparePanel';
import { BenchmarkGuide } from './BenchmarkGuide';
import { BenchmarkBatchPanel } from './BenchmarkBatchPanel';
import { BenchmarkResultsImportPanel } from './BenchmarkResultsImportPanel';

/**
 * Score off the main thread via the metrics worker (HD95/ASSD are O(surface²));
 * fall back to synchronous scoring if the worker can't be created.
 */
async function runScoring(input: ScoreInputs): Promise<MultiLabelResult> {
  try {
    const worker = new Worker(new URL('../workers/metrics.worker.ts', import.meta.url), {
      type: 'module',
    });
    const api = Comlink.wrap<MetricsApi>(worker);
    try {
      return await api.computeSegmentation(input);
    } finally {
      worker.terminate();
    }
  } catch {
    return scoreSegmentation(input);
  }
}

function uniqueLabels(mask: Uint8Array, cap = 64): number[] {
  const set = new Set<number>();
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i]!;
    if (v !== 0) {
      set.add(v);
      if (set.size >= cap) break;
    }
  }
  return [...set].sort((a, b) => a - b);
}

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export function BenchmarkPanel() {
  const profileId = useBenchmarkStore((s) => s.currentProfileId);
  const reference = useBenchmarkStore((s) => s.reference);
  const setReference = useBenchmarkStore((s) => s.setReference);
  const records = useBenchmarkStore((s) => s.records);
  const setRecords = useBenchmarkStore((s) => s.setRecords);
  const addRecord = useBenchmarkStore((s) => s.addRecord);
  const tick = useBenchmarkStore((s) => s.tick);

  const result = useAppStore((s) => s.result);
  const volume = useAppStore((s) => s.volume);
  const model = useAppStore((s) => s.model);
  const runMeta = useAppStore((s) => s.runMeta);
  const backend = useAppStore((s) => s.backend);

  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [surface, setSurface] = useState(true);
  const [mode, setMode] = useState<'image' | 'excel'>('image');
  const [diffSlice, setDiffSlice] = useState<DiffSlice | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [intendedUse, setIntendedUse] = useState('');
  const [limitations, setLimitations] = useState('');
  const onnxRef = useRef<HTMLInputElement>(null);
  const manifestRef = useRef<HTMLInputElement>(null);

  const modelMeta = () => ({
    ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
    ...(intendedUse.trim() ? { intendedUse: intendedUse.trim() } : {}),
    ...(limitations.trim() ? { limitations: limitations.trim() } : {}),
  });

  useEffect(() => {
    if (profileId) setEntries(listRegistry(profileId));
    else setEntries([]);
  }, [profileId, tick]);

  useEffect(() => {
    let cancelled = false;
    if (profileId) {
      void listRecords(profileId).then((r) => {
        if (!cancelled) setRecords(r);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [profileId, setRecords]);

  // No gate: a default "Local" profile is auto-provisioned (see benchmarkStore),
  // so users benchmark immediately. Named/passphrase profiles stay opt-in (👤).

  async function onAddModel() {
    setError(null);
    setNotice(null);
    const onnxFile = onnxRef.current?.files?.[0];
    const manifestFile = manifestRef.current?.files?.[0];
    if (!onnxFile || !manifestFile) {
      setError('Pick both an .onnx file and its manifest .json.');
      return;
    }
    setBusy('Validating & registering model…');
    try {
      const manifest = parseManifest(JSON.parse(await manifestFile.text()));
      const bytes = asBytes(new Uint8Array(await onnxFile.arrayBuffer()));
      const validation = validateOnnx(bytes);
      const hash = await sha256Hex(bytes);
      await cacheModel(bytes, manifest);
      registerModel(profileId!, { hash, manifest, validation, ...modelMeta() });
      setEntries(listRegistry(profileId!));
      if (onnxRef.current) onnxRef.current.value = '';
      if (manifestRef.current) manifestRef.current.value = '';
      setNotice(
        validation.ok
          ? `Registered "${manifest.name}" (opset ${validation.opsets[0]?.version ?? '?'}).`
          : `Registered "${manifest.name}" with warnings — see the badge.`
      );
    } catch (e) {
      setError(`Could not register model: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  function onAddLoadedModel() {
    setError(null);
    setNotice(null);
    if (!model) {
      setError('No model is loaded in the viewer.');
      return;
    }
    const validation = validateOnnx(model.bytes);
    registerModel(profileId!, { hash: model.hash, manifest: model.manifest, validation, ...modelMeta() });
    setEntries(listRegistry(profileId!));
    setNotice(`Registered loaded model "${model.manifest.name}".`);
  }

  function onRemoveEntry(hash: string) {
    removeModel(profileId!, hash);
    setEntries(listRegistry(profileId!));
  }

  function captureResultReference() {
    setError(null);
    if (!result) {
      setError('No inference result to capture. Run a model first.');
      return;
    }
    setReference({
      source: 'result',
      label: `${model?.manifest.name ?? 'model'} output`,
      mask: new Uint8Array(result.mask),
      dims: result.dims,
      spacing: result.spacing,
    });
    setNotice('Captured current result as the reference.');
  }

  async function onImportReferenceFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    setBusy('Loading reference mask…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = file.name.toLowerCase();
      const isDicom = name.endsWith('.dcm') || (bytes.length > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d);
      if (isDicom) {
        // Try DICOM-SEG first (self-geometric); fall back to RTSTRUCT which needs
        // the loaded reference image's grid (origin/spacing/dims) to rasterize.
        let out: { mask: Uint8Array; dims: [number, number, number]; spacing?: [number, number, number] };
        try {
          out = readDicomSeg(bytes);
        } catch {
          if (!volume) throw new Error('RTSTRUCT needs the reference image loaded first (for its grid).');
          const rt = readRtStruct(bytes, {
            origin: volume.meta.origin,
            spacing: volume.meta.spacing,
            dims: volume.meta.dims,
          });
          out = { mask: rt.mask, dims: rt.dims, spacing: volume.meta.spacing };
        }
        setReference({
          source: 'volume',
          label: file.name,
          mask: out.mask,
          dims: out.dims,
          spacing: out.spacing ?? (volume?.meta.spacing ?? [1, 1, 1]),
        });
        setNotice(`Loaded DICOM reference "${file.name}" (${out.dims.join('×')}).`);
        return;
      }
      const nm = await readNiftiMask(bytes, file.name);
      setReference({ source: 'volume', label: file.name, mask: nm.mask, dims: nm.dims, spacing: nm.spacing });
      setNotice(`Loaded reference mask "${file.name}" (${nm.dims.join('×')}).`);
    } catch (e) {
      setError(`Could not read reference mask: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  function captureVolumeReference() {
    setError(null);
    if (!volume) {
      setError('No volume loaded. Load a ground-truth mask as a volume, then capture it.');
      return;
    }
    const v = volume.voxels;
    const mask = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const x = Math.round(v[i] as number);
      mask[i] = x < 0 ? 0 : x > 255 ? 255 : x;
    }
    setReference({
      source: 'volume',
      label: volume.source.name,
      mask,
      dims: volume.meta.dims,
      spacing: volume.meta.spacing,
    });
    setNotice(`Captured "${volume.source.name}" as the reference.`);
  }

  async function onScore() {
    setError(null);
    setNotice(null);
    if (!result) {
      setError('No current inference result to score. Run a model in the viewer first.');
      return;
    }
    if (!reference) {
      setError('Capture a reference first (ground-truth volume or a prior model output).');
      return;
    }
    setBusy('Scoring against reference…');
    try {
      const labelSet = new Set<number>([...uniqueLabels(reference.mask), ...uniqueLabels(result.mask)]);
      const labels = [...labelSet].sort((a, b) => a - b);
      const t0 = performance.now();
      const metrics = await runScoring({
        refMask: reference.mask,
        refGrid: { dims: reference.dims, spacing: reference.spacing },
        predMask: result.mask,
        predGrid: { dims: result.dims, spacing: result.spacing },
        labels,
        options: { surface },
      });
      const metricMs = performance.now() - t0;

      const record: BenchmarkRecord = {
        schema: 'tamias.benchmark.v1',
        id: crypto.randomUUID(),
        profileId: profileId!,
        datasetName: reference.label,
        task: 'segmentation',
        model: {
          name: model?.manifest.name ?? 'current-model',
          version: model?.manifest.version ?? 'unknown',
          sha256: model?.hash ?? '',
        },
        case: {
          caseId: volume?.source.name ?? 'current-case',
          imageName: volume?.source.name ?? 'current-case',
          referenceName: reference.label,
        },
        runtime: {
          provider: runMeta?.provider ?? 'wasm',
          inferMs: result.elapsedMs,
          metricMs,
          totalMs: result.elapsedMs + metricMs,
        },
        segmentation: metrics.perLabel,
        env: captureEnv(backend, __APP_VERSION__),
        createdAt: new Date().toISOString(),
        appVersion: __APP_VERSION__,
      };
      await appendRecord(profileId!, record);
      addRecord(record);
      setNotice(`Scored: macro Dice ${fmt(metrics.macroDice)} across ${labels.length} label(s).`);
    } catch (e) {
      setError(`Scoring failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  function onShowDiff() {
    setError(null);
    if (!result || !reference) {
      setError('Need both a current result and a captured reference to show the difference.');
      return;
    }
    try {
      // Bring the reference onto the result's grid, then build a categorical
      // agreement map (green = both, blue = only result, pink = only reference).
      const aligned = alignToPrediction(
        reference.mask,
        { dims: reference.dims, spacing: reference.spacing },
        result.mask,
        { dims: result.dims, spacing: result.spacing },
      );
      const d = diffVolume(result.mask, aligned.ref);
      const dims: [number, number, number] = [aligned.dims[0], aligned.dims[1], aligned.dims[2]];
      setDiffSlice(maxDisagreementSlice(d.diff, dims));
      setNotice(`Difference: IoU ${fmt(d.agreeFraction)} · only-result ${d.aOnly} · only-reference ${d.bOnly} voxels.`);
    } catch (e) {
      setError(`Could not compute difference: ${(e as Error).message}`);
    }
  }

  async function onClearRecords() {
    await clearRecords(profileId!);
    setRecords([]);
  }

  const summary = summarizeSegmentation(records);

  return (
    <div className="space-y-4 text-xs">
      <BenchmarkGuide />

      {/* Input-mode fork: run models on images, or import already-computed results. */}
      <div className="inline-flex overflow-hidden rounded border border-slate-300 dark:border-slate-600">
        <button
          type="button"
          onClick={() => setMode('image')}
          className={`px-2 py-1 ${mode === 'image' ? 'bg-tamias-accent text-white' : 'text-slate-500 dark:text-slate-400'}`}
        >
          Run on images
        </button>
        <button
          type="button"
          onClick={() => setMode('excel')}
          className={`px-2 py-1 ${mode === 'excel' ? 'bg-tamias-accent text-white' : 'text-slate-500 dark:text-slate-400'}`}
        >
          Import results (Excel)
        </button>
      </div>

      {mode === 'excel' && <BenchmarkResultsImportPanel />}

      {mode === 'image' && (
      <>
      {/* Registry */}
      <section className="space-y-2">
        <div className="font-semibold text-tamias-ink dark:text-slate-100">Your models</div>
        <div className="grid grid-cols-1 gap-1">
          <label className="text-slate-500 dark:text-slate-400">
            ONNX file
            <input ref={onnxRef} type="file" accept=".onnx" className="mt-0.5 block w-full text-xs" />
          </label>
          <label className="text-slate-500 dark:text-slate-400">
            Manifest JSON
            <input ref={manifestRef} type="file" accept=".json,application/json" className="mt-0.5 block w-full text-xs" />
          </label>
          <input
            type="text"
            value={sourceUrl}
            onChange={(ev) => setSourceUrl(ev.target.value)}
            placeholder="Source URL (optional)"
            className="h-6 w-full rounded border border-slate-300 px-1 text-[11px] dark:border-slate-600 dark:bg-slate-800"
          />
          <input
            type="text"
            value={intendedUse}
            onChange={(ev) => setIntendedUse(ev.target.value)}
            placeholder="Intended use (optional)"
            className="h-6 w-full rounded border border-slate-300 px-1 text-[11px] dark:border-slate-600 dark:bg-slate-800"
          />
          <input
            type="text"
            value={limitations}
            onChange={(ev) => setLimitations(ev.target.value)}
            placeholder="Limitations (optional)"
            className="h-6 w-full rounded border border-slate-300 px-1 text-[11px] dark:border-slate-600 dark:bg-slate-800"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void onAddModel()} disabled={!!busy}>
              <Plus className="h-3 w-3" /> Register
            </Button>
            <Button size="sm" variant="outline" onClick={onAddLoadedModel} disabled={!model}>
              Add loaded model
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          {entries.length === 0 && <div className="text-slate-400">No models registered yet.</div>}
          {entries.map((e) => (
            <div
              key={e.hash}
              className="flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1 dark:border-slate-800"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-tamias-ink dark:text-slate-100">
                  {e.name} <span className="text-slate-400">v{e.version}</span>
                </div>
                <div className="truncate text-slate-400">
                  {e.modality} · opset {e.validation.opsets[0]?.version ?? '?'}
                  {e.validation.precision ? ` · ${e.validation.precision}` : ''}
                  {e.validation.inputShape ? ` · [${e.validation.inputShape.join('×')}]` : ''}
                  {e.validation.opTypes?.length ? ` · ${e.validation.opTypes.length} ops` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {e.validation.ok ? (
                  e.validation.warningCount > 0 ? (
                    <Badge variant="outline" title="Valid with warnings">
                      <AlertTriangle className="h-3 w-3 text-amber-500" />
                    </Badge>
                  ) : (
                    <Badge variant="outline" title="Valid">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    </Badge>
                  )
                ) : (
                  <Badge variant="outline" title="Invalid ONNX">
                    <AlertTriangle className="h-3 w-3 text-red-500" />
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveEntry(e.hash)}
                  className="text-slate-400 hover:text-red-500"
                  title="Remove from registry"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Reference */}
      <section className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="font-semibold text-tamias-ink dark:text-slate-100">Reference (ground truth)</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={captureVolumeReference} disabled={!volume}>
            <Crosshair className="h-3 w-3" /> Use loaded volume
          </Button>
          <Button size="sm" variant="outline" onClick={captureResultReference} disabled={!result}>
            <Crosshair className="h-3 w-3" /> Use current result
          </Button>
        </div>
        <label className="block text-slate-500 dark:text-slate-400">
          …or load a ground-truth mask file (NIfTI .nii/.nii.gz, DICOM-SEG/RTSTRUCT .dcm)
          <input
            type="file"
            accept=".nii,.nii.gz,.gz,.dcm"
            className="mt-0.5 block w-full text-xs"
            onChange={(e) => void onImportReferenceFile(e.target.files?.[0])}
          />
        </label>
        {reference ? (
          <div className="flex items-center justify-between rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            <span className="truncate">
              {reference.label} · {reference.dims.join('×')} ({reference.source})
            </span>
            <button type="button" onClick={() => setReference(null)} className="hover:text-red-500">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <div className="text-slate-400">No reference captured.</div>
        )}
      </section>

      {/* Score */}
      <section className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="font-semibold text-tamias-ink dark:text-slate-100">Score current result</div>
        <label className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
          <input type="checkbox" checked={surface} onChange={(e) => setSurface(e.target.checked)} />
          Compute surface metrics (HD95 / ASSD) — slower on large volumes
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void onScore()} disabled={!!busy || !result || !reference}>
            <Play className="h-3 w-3" /> Score vs reference
          </Button>
          <Button size="sm" variant="outline" onClick={onShowDiff} disabled={!result || !reference}>
            <Crosshair className="h-3 w-3" /> Show difference
          </Button>
        </div>
        {diffSlice && (
          <div className="rounded border border-slate-100 p-2 dark:border-slate-800">
            <MaskDiffCanvas
              slice={diffSlice}
              labelA="result"
              labelB="reference"
            />
          </div>
        )}
      </section>

      {/* Batch — two models over many images (view one, compare all) */}
      <BenchmarkBatchPanel profileId={profileId!} entries={entries} />
      </>
      )}

      {/* Comparison */}
      <section className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-tamias-ink dark:text-slate-100">Comparison ({records.length} runs)</div>
          {records.length > 0 && (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => download('tamias-benchmark.csv', recordsToCsv(records), 'text/csv')}
              >
                <Download className="h-3 w-3" /> CSV
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => download('tamias-benchmark.json', recordsToJson(records), 'application/json')}
              >
                <Download className="h-3 w-3" /> JSON
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  download(
                    'tamias-benchmark-report.html',
                    generateHtmlReport({
                      profileName: profileId!,
                      generatedAt: new Date().toISOString(),
                      records,
                      summary,
                    }),
                    'text/html'
                  )
                }
              >
                <Download className="h-3 w-3" /> Report
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void onClearRecords()}>
                Clear
              </Button>
            </div>
          )}
        </div>
        {summary.length === 0 ? (
          <div className="text-slate-400">No scored runs yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[11px]">
              <thead>
                <tr className="text-slate-500 dark:text-slate-400">
                  <th className="py-1 pr-2">Model</th>
                  <th className="py-1 pr-2">n</th>
                  <th className="py-1 pr-2">Dice</th>
                  <th className="py-1 pr-2">IoU</th>
                  <th className="py-1 pr-2">HD95</th>
                  <th className="py-1 pr-2">ASSD</th>
                  <th className="py-1 pr-2">ms</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((m) => (
                  <tr key={`${m.modelName}@${m.modelVersion}`} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1 pr-2 font-medium text-tamias-ink dark:text-slate-100">
                      {m.modelName} <span className="text-slate-400">v{m.modelVersion}</span>
                    </td>
                    <td className="py-1 pr-2">{m.cases}</td>
                    <td className="py-1 pr-2">{fmt(m.meanDice)}</td>
                    <td className="py-1 pr-2">{fmt(m.meanIou)}</td>
                    <td className="py-1 pr-2">{fmt(m.meanHd95Mm, 2)}</td>
                    <td className="py-1 pr-2">{fmt(m.meanAssdMm, 2)}</td>
                    <td className="py-1 pr-2">{fmt(m.meanInferMs, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ≥2 models per dataset + cross-dataset shift (Friedman / Nemenyi / Holm / Mann-Whitney) */}
      <BenchmarkComparePanel records={records} profileId={profileId} onImported={setRecords} />

      {/* Statistical model comparison (corrected t-tests + non-parametric + Bayesian) */}
      <BenchmarkStatsPanel records={records} />

      {/* AUROC comparison (DeLong) + paired classifier (McNemar) from imported scores */}
      <BenchmarkRocComparePanel />

      {/* Phase 2-3: completeness, subgroups, concordance, case review, privacy */}
      <BenchmarkAnalysisPanel records={records} profileId={profileId} />

      {/* Classification + detection tasks (doc §5) */}
      <BenchmarkClassifyPanel />
      <BenchmarkDetectionPanel />

      {/* Phase 4: model cards, benchmark definitions, reference-set locking */}
      <BenchmarkGovernancePanel
        profileId={profileId}
        entries={entries}
        loadedModel={model}
        reference={reference}
        records={records}
      />

      {busy && <div className="text-tamias-accent">{busy}</div>}
      {notice && <div className="text-emerald-600 dark:text-emerald-400">{notice}</div>}
      {error && <div className="text-red-500">{error}</div>}
    </div>
  );
}
