/**
 * Benchmark run record — `tamias.benchmark.v1`.
 *
 * One record = one model evaluated on one case. It extends the spirit of the
 * reproducibility bundle (`tamias.repro.v1`): it captures what ran (model
 * name/version/hash), against what (case id + file names + optional hashes),
 * how fast (runtime), and how well (metrics). Like the repro bundle it stores
 * names + hashes only, never image bytes / PHI.
 */

import type { SegMetrics } from '../metrics/segmentation';
import type { ClassificationMetrics } from '../metrics/classification';
import type { BenchmarkTask, CaseMeta } from '../datasets/manifest';

/**
 * Reproducibility environment capture (Phase 3): what hardware/runtime produced
 * a record, so results can be compared across browsers/devices. No PHI.
 */
export interface ReproEnv {
  provider: string;
  adapterVendor?: string;
  adapterArchitecture?: string;
  wasmThreads?: number;
  crossOriginIsolated?: boolean;
  userAgent?: string;
  appVersion: string;
  /** Where the run happened: browser PWA, Tauri desktop, or the headless runner. */
  runner?: 'browser' | 'desktop' | 'headless';
  /** Logical CPU cores visible to the runtime (navigator.hardwareConcurrency / os.cpus()). */
  cpuCores?: number;
  /** CPU model string (headless only; browsers do not expose it). */
  cpuModel?: string;
  /** Device / system memory in GB (navigator.deviceMemory is coarse and capped at 8). */
  memoryGb?: number;
  /** OS / platform string. */
  os?: string;
  /** onnxruntime package + version, e.g. "onnxruntime-node 1.22.0". */
  ortVersion?: string;
  /** Peak resident memory of the process in MB (headless). */
  peakRssMb?: number;
}

export interface BenchmarkModelRef {
  name: string;
  version: string;
  /** SHA-256 of the .onnx bytes. */
  sha256: string;
  /** Catalogue model id when the model came from the Model & Dataset Catalogue. */
  catalogId?: string;
}

export interface BenchmarkCaseRef {
  caseId: string;
  imageName: string;
  /** SHA-256 of the input bytes, when computed. */
  imageSha256?: string;
  /** Reference/ground-truth file name (segmentation). */
  referenceName?: string;
  /** DICOM/exam metadata for subgroup + completeness analysis (Phase 2-3). */
  meta?: CaseMeta;
  /**
   * Result indicator + AI result value (Assess-AI concordance, Phase 2):
   * the code the result pertains to (e.g. "ICH") and the AI's output value.
   */
  resultIndicator?: string;
  aiResult?: string;
  /** Reference/report value for the same indicator (for concordance). */
  referenceResult?: string;
}

export interface BenchmarkRuntime {
  /** Resolved execution provider (webgpu | webnn | wasm). */
  provider: string;
  /** Model load time in ms, when measured. */
  loadMs?: number;
  /** Inference wall-clock in ms. */
  inferMs: number;
  /** Metric computation time in ms, when measured. */
  metricMs?: number;
  /** End-to-end workflow time in ms. */
  totalMs: number;
}

export interface BenchmarkRecord {
  schema: 'tamias.benchmark.v1';
  /** Unique record id. */
  id: string;
  /** Owning local profile. */
  profileId: string;
  datasetName: string;
  task: BenchmarkTask;
  model: BenchmarkModelRef;
  case: BenchmarkCaseRef;
  runtime: BenchmarkRuntime;
  /** Per-label segmentation metrics (task === "segmentation"). */
  segmentation?: SegMetrics[];
  /** Classification metrics (task === "classification"). */
  classification?: ClassificationMetrics;
  /** Reproducibility environment (Phase 3). */
  env?: ReproEnv;
  createdAt: string;
  appVersion: string;
}

/** Aggregate one model's segmentation records into mean Dice/IoU/HD95/ASSD. */
export interface ModelSummary {
  modelName: string;
  modelVersion: string;
  cases: number;
  meanDice: number;
  meanIou: number;
  meanHd95Mm: number;
  meanAssdMm: number;
  meanInferMs: number;
}

function mean(nums: number[]): number {
  const valid = nums.filter((n) => Number.isFinite(n));
  return valid.length === 0 ? NaN : valid.reduce((s, v) => s + v, 0) / valid.length;
}

/**
 * Summarize a set of segmentation records grouped by model (name+version).
 * Macro-averages each record's per-label Dice/IoU first, then across cases.
 */
export function summarizeSegmentation(records: BenchmarkRecord[]): ModelSummary[] {
  const groups = new Map<string, BenchmarkRecord[]>();
  for (const r of records) {
    if (r.task !== 'segmentation' || !r.segmentation) continue;
    const key = `${r.model.name}@@${r.model.version}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const out: ModelSummary[] = [];
  for (const [, recs] of groups) {
    const perCaseDice = recs.map((r) => mean(r.segmentation!.map((s) => s.dice)));
    const perCaseIou = recs.map((r) => mean(r.segmentation!.map((s) => s.iou)));
    const perCaseHd95 = recs.map((r) => mean(r.segmentation!.map((s) => s.hd95Mm)));
    const perCaseAssd = recs.map((r) => mean(r.segmentation!.map((s) => s.assdMm)));
    out.push({
      modelName: recs[0]!.model.name,
      modelVersion: recs[0]!.model.version,
      cases: recs.length,
      meanDice: mean(perCaseDice),
      meanIou: mean(perCaseIou),
      meanHd95Mm: mean(perCaseHd95),
      meanAssdMm: mean(perCaseAssd),
      meanInferMs: mean(recs.map((r) => r.runtime.inferMs)),
    });
  }
  // Best Dice first.
  out.sort((a, b) => (b.meanDice || 0) - (a.meanDice || 0));
  return out;
}
