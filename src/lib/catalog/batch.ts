/**
 * In-app catalogue batch benchmark: run N models over M cases of a dataset and
 * score each prediction against the case ground truth — the same workflow as
 * the headless runner, driven from the UI.
 *
 * Case-outer / model-inner: exactly one decoded case and one model are held in
 * memory at a time (model bytes come from the OPFS cache on repeat loads), so a
 * 10 × 10 grid fits in a browser tab. Each (case, model) pair is isolated: a
 * failure is recorded and the batch continues; a model that fails to load is
 * not downloaded again for later cases (each remaining pair records the
 * error). Cancellable, and resumable via `isDone` (see {@link isPairRecorded}).
 * Pure orchestration — all I/O is injected.
 */

import type { SegMetrics } from '../metrics/segmentation';

export interface BatchCase {
  datasetId: string;
  caseId: string;
}

export interface BatchModel {
  id: string;
  name: string;
}

export interface BatchReference {
  mask: Uint8Array;
  dims: [number, number, number];
  spacing: [number, number, number];
}

export interface BatchPrediction {
  mask: Uint8Array;
  dims: [number, number, number];
  spacing: [number, number, number];
  elapsedMs: number;
  provider: string;
}

export interface BatchResult<V, M> {
  case: BatchCase;
  model: BatchModel;
  loadedModel: M;
  volume: V;
  reference: BatchReference;
  prediction: BatchPrediction;
  metrics: SegMetrics[];
}

export interface BatchProgress {
  done: number;
  total: number;
  caseId: string;
  modelId?: string;
  stage: 'loading case' | 'loading model' | 'inference' | 'scoring';
}

export interface BatchDeps<V, M> {
  loadCase(c: BatchCase): Promise<{ volume: V; reference: BatchReference }>;
  loadModel(m: BatchModel): Promise<M>;
  infer(volume: V, model: M): Promise<BatchPrediction>;
  score(reference: BatchReference, prediction: BatchPrediction, model: M): Promise<SegMetrics[]>;
  onResult(r: BatchResult<V, M>): void | Promise<void>;
  onProgress?(p: BatchProgress): void;
  /** Skip pairs already recorded (resume). */
  isDone?(c: BatchCase, m: BatchModel): boolean;
  signal?: { aborted: boolean };
}

export interface BatchFailure {
  datasetId: string;
  caseId: string;
  /** Absent when the case itself failed to load. */
  modelId?: string;
  error: string;
}

export interface BatchSummary {
  completed: number;
  skipped: number;
  failed: BatchFailure[];
  cancelled: boolean;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Minimal shape of a stored benchmark record needed to detect a finished pair. */
export interface RecordedPair {
  datasetName: string;
  case: { caseId: string };
  model: { catalogId?: string };
}

/** True when `records` already hold a result for this catalogue (case, model) pair. */
export function isPairRecorded(records: readonly RecordedPair[], c: BatchCase, m: BatchModel): boolean {
  return records.some((r) => r.datasetName === c.datasetId && r.case.caseId === c.caseId && r.model.catalogId === m.id);
}

export async function runCatalogBatch<V, M>(
  cases: readonly BatchCase[],
  models: readonly BatchModel[],
  deps: BatchDeps<V, M>
): Promise<BatchSummary> {
  const total = cases.length * models.length;
  const out: BatchSummary = { completed: 0, skipped: 0, failed: [], cancelled: false };
  let done = 0;
  /** Models that failed to load: not retried for later cases. */
  const modelLoadErrors = new Map<string, string>();
  const progress = (p: Omit<BatchProgress, 'done' | 'total'>) => deps.onProgress?.({ done, total, ...p });

  for (const c of cases) {
    if (deps.signal?.aborted) {
      out.cancelled = true;
      break;
    }
    const todo = models.filter((m) => !deps.isDone?.(c, m));
    out.skipped += models.length - todo.length;
    done += models.length - todo.length;
    if (!todo.length) continue;

    progress({ caseId: c.caseId, stage: 'loading case' });
    let loaded: { volume: V; reference: BatchReference };
    try {
      loaded = await deps.loadCase(c);
    } catch (e) {
      if (deps.signal?.aborted) {
        out.cancelled = true;
        break;
      }
      out.failed.push({ datasetId: c.datasetId, caseId: c.caseId, error: msg(e) });
      done += todo.length;
      continue;
    }

    for (const m of todo) {
      if (deps.signal?.aborted) {
        out.cancelled = true;
        break;
      }
      const loadError = modelLoadErrors.get(m.id);
      if (loadError !== undefined) {
        out.failed.push({ datasetId: c.datasetId, caseId: c.caseId, modelId: m.id, error: `model failed to load earlier: ${loadError}` });
        done++;
        continue;
      }
      let lm: M;
      try {
        progress({ caseId: c.caseId, modelId: m.id, stage: 'loading model' });
        lm = await deps.loadModel(m);
      } catch (e) {
        if (deps.signal?.aborted) {
          out.cancelled = true;
          break;
        }
        modelLoadErrors.set(m.id, msg(e));
        out.failed.push({ datasetId: c.datasetId, caseId: c.caseId, modelId: m.id, error: msg(e) });
        done++;
        continue;
      }
      try {
        progress({ caseId: c.caseId, modelId: m.id, stage: 'inference' });
        const prediction = await deps.infer(loaded.volume, lm);
        progress({ caseId: c.caseId, modelId: m.id, stage: 'scoring' });
        const metrics = await deps.score(loaded.reference, prediction, lm);
        await deps.onResult({ case: c, model: m, loadedModel: lm, volume: loaded.volume, reference: loaded.reference, prediction, metrics });
        out.completed++;
      } catch (e) {
        out.failed.push({ datasetId: c.datasetId, caseId: c.caseId, modelId: m.id, error: msg(e) });
      }
      done++;
    }
    if (out.cancelled) break;
  }
  return out;
}
