/**
 * Batch benchmarking: run TWO models across MANY images at once, view one, and
 * compare — all local, streaming one volume at a time.
 *
 * Flow:
 *  1. Pick 20-ish images (.nii/.nii.gz) and, optionally, matching ground-truth
 *     masks (paired by file-name stem).
 *  2. Pick Model A and Model B from your registry.
 *  3. Run: each image is decoded, both models run, and — if a GT mask is present
 *     — each model is scored (Dice/IoU/HD95/ASSD). A tiny 2D mask-difference
 *     slice is kept per case so you can flip through disagreements ("view one").
 *
 * Memory-safe by construction: volumes are decoded and freed one at a time; only
 * a small 2D preview slice is retained per case, never the full 3D masks.
 */

import { useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { Play, Square, Layers } from 'lucide-react';
import { useBenchmarkStore } from '../lib/state/benchmarkStore';
import type { RegistryEntry } from '../lib/registry/registry';
import { loadCachedModel } from '../lib/fs/opfs';
import { readNiftiVolume, type VolumeVoxels } from '../lib/datasets/nifti-volume';
import { readNiftiMask } from '../lib/datasets/nifti-mask';
import { pairImagesAndMasks, type BatchCase } from '../lib/benchmark/batch';
import { runBatch, summarizeBatch, type BatchCaseOutcome, type BatchProgress } from '../lib/benchmark/batch-runner';
import { diffVolume, maxDisagreementSlice, type DiffSlice } from '../lib/metrics/mask-diff';
import { scoreSegmentation } from '../lib/metrics/score';
import { appendRecord } from '../lib/benchmark/store';
import type { BenchmarkRecord } from '../lib/benchmark/types';
import type { InferenceApi, InferenceInputs, InferenceProgressEvent } from '../workers/inference.worker';
import type { Bytes, ModelManifest } from '../types';
import { Button } from './ui/Button';
import { MaskDiffCanvas } from './MaskDiffCanvas';

interface Props {
  profileId: string;
  entries: RegistryEntry[];
}

interface LoadedModel {
  hash: string;
  name: string;
  version: string;
  bytes: Bytes;
  manifest: ModelManifest;
}

function uniqueForeground(mask: Uint8Array, cap = 64): number[] {
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

/** Run one inference on an already-decoded volume; returns the mask + grid. */
async function infer(
  api: InferenceApi,
  voxels: VolumeVoxels,
  dims: [number, number, number],
  spacing: [number, number, number],
  origin: [number, number, number],
  model: LoadedModel,
  affine: Pick<InferenceInputs, 'srowX' | 'srowY' | 'srowZ'> = {},
): Promise<{ mask: Uint8Array; dims: [number, number, number]; spacing: [number, number, number]; elapsedMs: number; provider: string }> {
  const noop = Comlink.proxy((_e: InferenceProgressEvent) => {});
  const res = await api.run(
    { voxels, dims, spacing, origin, modelBytes: model.bytes, manifest: model.manifest, ...affine },
    noop,
  );
  return { mask: res.mask, dims: res.dims, spacing: res.spacing, elapsedMs: res.elapsedMs, provider: res.provider };
}

export function BenchmarkBatchPanel({ profileId, entries }: Props) {
  const records = useBenchmarkStore((s) => s.records);
  const setRecords = useBenchmarkStore((s) => s.setRecords);

  const imageRef = useRef<HTMLInputElement>(null);
  const maskRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);

  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [maskFiles, setMaskFiles] = useState<File[]>([]);
  const [modelA, setModelA] = useState('');
  const [modelB, setModelB] = useState('');
  const [surface, setSurface] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [outcomes, setOutcomes] = useState<BatchCaseOutcome[]>([]);
  const [previews, setPreviews] = useState<Record<string, DiffSlice>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const cases: BatchCase[] = useMemo(
    () => pairImagesAndMasks(imageFiles.map((f) => f.name), maskFiles.map((f) => f.name)),
    [imageFiles, maskFiles],
  );
  const pairedRefs = cases.filter((c) => c.referenceName).length;

  const modelAEntry = entries.find((e) => e.hash === (modelA || entries[0]?.hash));
  const modelBEntry = entries.find((e) => e.hash === (modelB || entries[1]?.hash));

  async function onRun() {
    setError(null);
    setNotice(null);
    if (cases.length === 0) {
      setError('Pick at least one image file.');
      return;
    }
    if (!modelAEntry || !modelBEntry || modelAEntry.hash === modelBEntry.hash) {
      setError('Pick two different registered models.');
      return;
    }

    setRunning(true);
    cancelRef.current = false;
    setOutcomes([]);
    setPreviews({});

    const imageByName = new Map(imageFiles.map((f) => [f.name, f]));
    const maskByName = new Map(maskFiles.map((f) => [f.name, f]));
    const newPreviews: Record<string, DiffSlice> = {};

    const worker = new Worker(new URL('../workers/inference.worker.ts', import.meta.url), { type: 'module' });
    const api = Comlink.wrap<InferenceApi>(worker);
    const collected: BenchmarkRecord[] = [];

    try {
      const a = await loadCachedModel(modelAEntry.hash);
      const b = await loadCachedModel(modelBEntry.hash);
      if (!a || !b) throw new Error('A selected model is not in the local cache — re-register it.');
      const mA: LoadedModel = { hash: modelAEntry.hash, name: a.meta.name, version: a.meta.manifest.version, bytes: a.bytes, manifest: a.meta.manifest as LoadedModel['manifest'] };
      const mB: LoadedModel = { hash: modelBEntry.hash, name: b.meta.name, version: b.meta.manifest.version, bytes: b.bytes, manifest: b.meta.manifest as LoadedModel['manifest'] };

      const runOne = async (bc: BatchCase) => {
        const imgFile = imageByName.get(bc.imageName);
        if (!imgFile) throw new Error(`image file "${bc.imageName}" missing`);
        const vol = await readNiftiVolume(new Uint8Array(await imgFile.arrayBuffer()), bc.imageName);

        const affine = { srowX: vol.srowX, srowY: vol.srowY, srowZ: vol.srowZ };
        const rA = await infer(api, vol.voxels, vol.dims, vol.spacing, vol.origin, mA, affine);
        const rB = await infer(api, vol.voxels, vol.dims, vol.spacing, vol.origin, mB, affine);

        // Model-vs-model difference on the shared source grid.
        const d = diffVolume(rA.mask, rB.mask);
        const slice = maxDisagreementSlice(d.diff, rA.dims);
        newPreviews[bc.caseId] = slice;

        const recs: BenchmarkRecord[] = [];
        let scored = false;
        if (bc.referenceName) {
          const refFile = maskByName.get(bc.referenceName);
          if (refFile) {
            const ref = await readNiftiMask(new Uint8Array(await refFile.arrayBuffer()), bc.referenceName);
            const labels = [...new Set([...uniqueForeground(ref.mask), ...uniqueForeground(rA.mask), ...uniqueForeground(rB.mask)])].sort((x, y) => x - y);
            for (const [res, model] of [[rA, mA], [rB, mB]] as const) {
              const m = scoreSegmentation({
                refMask: ref.mask,
                refGrid: { dims: ref.dims, spacing: ref.spacing },
                predMask: res.mask,
                predGrid: { dims: res.dims, spacing: res.spacing },
                labels,
                options: { surface },
              });
              recs.push({
                schema: 'tamias.benchmark.v1',
                id: `batch:${model.name}:${bc.caseId}:${res.provider}`,
                profileId,
                datasetName: `batch (${imageFiles.length} images)`,
                task: 'segmentation',
                model: { name: model.name, version: model.version, sha256: model.hash },
                case: { caseId: bc.caseId, imageName: bc.imageName, referenceName: bc.referenceName },
                runtime: { provider: res.provider, inferMs: res.elapsedMs, totalMs: res.elapsedMs },
                segmentation: m.perLabel,
                env: { provider: res.provider, appVersion: __APP_VERSION__ },
                createdAt: new Date().toISOString(),
                appVersion: __APP_VERSION__,
              });
            }
            scored = true;
          }
        }
        collected.push(...recs);
        return {
          records: recs,
          diff: { both: d.both, aOnly: d.aOnly, bOnly: d.bOnly, agreeFraction: d.agreeFraction },
          scored,
        };
      };

      const result = await runBatch(cases, runOne, {
        onProgress: (p) => setProgress(p),
        shouldCancel: () => cancelRef.current,
      });
      setOutcomes(result);
      setPreviews(newPreviews);

      // Persist + merge scored records into the store (dedupe by id).
      for (const r of collected) await appendRecord(profileId, r);
      const byId = new Map(records.map((r) => [r.id, r]));
      for (const r of collected) byId.set(r.id, r);
      setRecords([...byId.values()]);

      const s = summarizeBatch(result);
      const firstWithPreview = result.find((o) => newPreviews[o.caseId]);
      if (firstWithPreview) setSelected(firstWithPreview.caseId);
      setNotice(
        `Done: ${s.ok}/${s.total} cases ran` +
          (s.failed ? `, ${s.failed} failed` : '') +
          (s.scored ? `, ${s.scored} scored vs ground truth` : ' — no ground-truth masks, showing model-vs-model agreement') +
          '. ' + (collected.length ? `${collected.length} records added to the comparison.` : ''),
      );
    } catch (e) {
      setError(`Batch failed: ${(e as Error).message}`);
    } finally {
      worker.terminate();
      setRunning(false);
      setProgress(null);
    }
  }

  const selectedOutcome = outcomes.find((o) => o.caseId === selected);
  const selectedSlice = selected ? previews[selected] ?? null : null;

  return (
    <section className="space-y-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
      <div className="font-semibold text-tamias-ink dark:text-slate-100">
        Batch — two models over many images
      </div>
      <div className="text-slate-500 dark:text-slate-400">
        Load many images (view one), run two models on all of them, compare. Ground-truth masks
        (paired by file-name stem) enable Dice/IoU/HD95; without them you still see model-vs-model
        agreement. Streamed one volume at a time — nothing is uploaded.
      </div>

      <div className="grid grid-cols-1 gap-1">
        <label className="text-slate-500 dark:text-slate-400">
          Images (.nii / .nii.gz) — select many
          <input
            ref={imageRef}
            type="file"
            multiple
            accept=".nii,.nii.gz,.gz"
            className="mt-0.5 block w-full text-xs"
            onChange={(e) => setImageFiles([...(e.target.files ?? [])])}
          />
        </label>
        <label className="text-slate-500 dark:text-slate-400">
          Ground-truth masks (optional) — paired by name
          <input
            ref={maskRef}
            type="file"
            multiple
            accept=".nii,.nii.gz,.gz"
            className="mt-0.5 block w-full text-xs"
            onChange={(e) => setMaskFiles([...(e.target.files ?? [])])}
          />
        </label>
      </div>

      {cases.length > 0 && (
        <div className="text-slate-500 dark:text-slate-400">
          {cases.length} case(s) · {pairedRefs} with ground truth
        </div>
      )}

      <div className="grid grid-cols-2 gap-1">
        <label className="text-slate-500 dark:text-slate-400">Model A
          <select value={modelA || entries[0]?.hash || ''} onChange={(e) => setModelA(e.target.value)} className="mt-0.5 block w-full rounded border border-slate-300 px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800">
            {entries.length === 0 && <option value="">No models registered</option>}
            {entries.map((e) => <option key={e.hash} value={e.hash}>{e.name} v{e.version}</option>)}
          </select>
        </label>
        <label className="text-slate-500 dark:text-slate-400">Model B
          <select value={modelB || entries[1]?.hash || ''} onChange={(e) => setModelB(e.target.value)} className="mt-0.5 block w-full rounded border border-slate-300 px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800">
            {entries.length === 0 && <option value="">No models registered</option>}
            {entries.map((e) => <option key={e.hash} value={e.hash}>{e.name} v{e.version}</option>)}
          </select>
        </label>
      </div>

      <label className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
        <input type="checkbox" checked={surface} onChange={(e) => setSurface(e.target.checked)} />
        Compute surface metrics (HD95 / ASSD) — slower across a batch
      </label>

      <div className="flex items-center gap-2">
        {!running ? (
          <Button size="sm" onClick={() => void onRun()} disabled={cases.length === 0 || entries.length < 2}>
            <Play className="h-3 w-3" /> Run batch
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => { cancelRef.current = true; }}>
            <Square className="h-3 w-3" /> Stop after current
          </Button>
        )}
        {progress && (
          <span className="text-tamias-accent">
            {progress.phase === 'error' ? '⚠ ' : ''}
            {progress.index + 1}/{progress.total} · {progress.caseId}
          </span>
        )}
      </div>

      {outcomes.length > 0 && (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[11px]">
              <thead>
                <tr className="text-slate-500 dark:text-slate-400">
                  <th className="py-1 pr-2">Case</th>
                  <th className="py-1 pr-2">GT</th>
                  <th className="py-1 pr-2">A∩B / A∪B</th>
                  <th className="py-1 pr-2">only A</th>
                  <th className="py-1 pr-2">only B</th>
                  <th className="py-1 pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map((o) => (
                  <tr
                    key={o.caseId}
                    className={`border-t border-slate-100 dark:border-slate-800 ${selected === o.caseId ? 'bg-slate-50 dark:bg-slate-800/50' : ''}`}
                  >
                    <td className="py-1 pr-2 font-medium text-tamias-ink dark:text-slate-100">
                      {o.error ? <span className="text-red-500" title={o.error}>⚠ {o.caseId}</span> : o.caseId}
                    </td>
                    <td className="py-1 pr-2">{o.scored ? '✓' : '—'}</td>
                    <td className="py-1 pr-2">{o.diff ? o.diff.agreeFraction.toFixed(3) : '—'}</td>
                    <td className="py-1 pr-2">{o.diff ? o.diff.aOnly : '—'}</td>
                    <td className="py-1 pr-2">{o.diff ? o.diff.bOnly : '—'}</td>
                    <td className="py-1 pr-2">
                      {previews[o.caseId] && (
                        <button
                          type="button"
                          className="text-tamias-accent hover:underline"
                          onClick={() => setSelected(o.caseId)}
                        >
                          <Layers className="inline h-3 w-3" /> view
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedSlice && (
            <div className="rounded border border-slate-100 p-2 dark:border-slate-800">
              <div className="mb-1 font-medium text-tamias-ink dark:text-slate-100">
                Disagreement — case {selected}
                {selectedOutcome?.diff && (
                  <span className="ml-1 text-slate-400">(IoU {selectedOutcome.diff.agreeFraction.toFixed(3)})</span>
                )}
              </div>
              <MaskDiffCanvas slice={selectedSlice} labelA={modelAEntry?.name} labelB={modelBEntry?.name} />
            </div>
          )}
        </div>
      )}

      {notice && <div className="text-emerald-600 dark:text-emerald-400">{notice}</div>}
      {error && <div className="text-red-500">{error}</div>}
    </section>
  );
}
