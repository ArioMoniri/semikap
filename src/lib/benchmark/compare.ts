/**
 * Shape benchmark records for multi-model (same dataset) and cross-dataset
 * (same model, different sources) statistics, plus NDJSON/JSON import so
 * results from the headless runner or another machine can be merged.
 */

import type { BenchmarkRecord } from './types';
import type { SegMetrics } from '../metrics/segmentation';
import { mannWhitneyU } from '../stats/multi-model';

/**
 * The headless runner names datasets by folder (hcc_tace_seg); the app uses
 * catalogue ids (hcc-tace-seg). Normalise so records from both merge.
 */
const DATASET_ALIASES: Record<string, string> = {
  hcc_tace_seg: 'hcc-tace-seg',
  msd_task03_liver: 'msd-task03-liver',
  colorectal_liver_metastases: 'crlm',
};
export function canonicalDatasetId(name: string): string {
  return DATASET_ALIASES[name] ?? name;
}

/**
 * Dataset key used for grouping: canonical dataset id plus the recorded
 * post-processing ("hcc-tace-seg [fov+lcc]"), so raw and post-processed scores
 * of the same cases are never pooled or ranked together.
 */
export function datasetKey(r: Pick<BenchmarkRecord, 'datasetName' | 'postprocess'>): string {
  const base = canonicalDatasetId(r.datasetName);
  return r.postprocess?.length ? `${base} [${r.postprocess.join('+')}]` : base;
}

/** Catalogue dataset id of a dataset key (strips the post-processing suffix). */
export function baseDatasetId(key: string): string {
  return canonicalDatasetId(key.replace(/ \[[^\]]*\]$/, ''));
}

export type SegMetricKey =
  | 'dice'
  | 'iou'
  | 'hd95Mm'
  | 'assdMm'
  | 'volumetricSimilarity'
  | 'precision'
  | 'recall'
  | 'nsd2Mm'
  | 'nsd5Mm';
const LOWER_IS_BETTER = new Set<SegMetricKey>(['hd95Mm', 'assdMm']);

/** Display key for a model; JSON tuple under the hood so names can't collide via the separator. */
export function modelKey(r: BenchmarkRecord): string {
  return r.model.version.includes('@') || r.model.name.includes('@')
    ? JSON.stringify([r.model.name, r.model.version])
    : `${r.model.name}@${r.model.version}`;
}

type MetricValue = number | 'fail' | null;

/**
 * A finite metric, `'fail'` for a surface distance that is undefined because
 * exactly one of prediction / reference is empty (Dice < 1: a segmentation
 * failure, which must not be silently dropped), or null when absent / both
 * masks empty (no structure to measure).
 */
function metricOf(r: BenchmarkRecord, label: number, metric: SegMetricKey): MetricValue {
  const m = r.segmentation?.find((s: SegMetrics) => s.label === label);
  const v = m ? m[metric] : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (m && LOWER_IS_BETTER.has(metric) && typeof m.dice === 'number' && m.dice < 1) return 'fail';
  return null;
}

/** Latest record per (dataset key, case, model) — re-runs replace, never double-count. */
export function latestPerPair(records: readonly BenchmarkRecord[]): BenchmarkRecord[] {
  const m = new Map<string, BenchmarkRecord>();
  for (const r of records) m.set(JSON.stringify([datasetKey(r), r.case.caseId, modelKey(r)]), r);
  return [...m.values()];
}

/** Failures score as the worst finite value observed (tied last in rank tests). */
function worstFinite(values: MetricValue[], higherIsBetter: boolean): number {
  const xs = values.filter((v): v is number => typeof v === 'number');
  if (!xs.length) return NaN;
  return higherIsBetter ? Math.min(...xs) : Math.max(...xs);
}

export interface MatrixQuery {
  dataset?: string;
  label: number;
  metric: SegMetricKey;
}

export interface ScoreMatrix {
  datasets: string[];
  models: string[];
  cases: string[];
  /** cases × models */
  values: number[][];
  droppedCases: string[];
  /** Per model: cases where the metric was undefined because the prediction or reference was empty (scored as the worst observed value). */
  failures: number[];
  higherIsBetter: boolean;
}

export function recordsToMatrix(records: readonly BenchmarkRecord[], q: MatrixQuery): ScoreMatrix {
  const seg = latestPerPair(records.filter((r) => r.task === 'segmentation'));
  const datasets = [...new Set(seg.map(datasetKey))].sort();
  const inDs = q.dataset ? seg.filter((r) => datasetKey(r) === canonicalDatasetId(q.dataset!)) : seg;
  const models = [...new Set(inDs.map(modelKey))].sort();
  // Rows are keyed by dataset + case so identical case ids from two sources never merge.
  const caseKey = (r: BenchmarkRecord) => (q.dataset ? r.case.caseId : `${datasetKey(r)}/${r.case.caseId}`);
  const higherIsBetter = !LOWER_IS_BETTER.has(q.metric);
  const byCase = new Map<string, Map<string, MetricValue>>();
  for (const r of inDs) {
    const v = metricOf(r, q.label, q.metric);
    if (v === null) continue;
    const row = byCase.get(caseKey(r)) ?? new Map<string, MetricValue>();
    row.set(modelKey(r), v);
    byCase.set(caseKey(r), row);
  }
  const penalty = worstFinite([...byCase.values()].flatMap((row) => [...row.values()]), higherIsBetter);
  const cases: string[] = [];
  const values: number[][] = [];
  const droppedCases: string[] = [];
  const failures = models.map(() => 0);
  for (const c of [...byCase.keys()].sort()) {
    const row = byCase.get(c)!;
    if (models.every((m) => row.has(m))) {
      cases.push(c);
      values.push(
        models.map((m, j) => {
          const v = row.get(m)!;
          if (v !== 'fail') return v;
          failures[j]!++;
          return penalty;
        })
      );
    } else droppedCases.push(c);
  }
  return { datasets, models, cases, values, droppedCases, failures, higherIsBetter };
}

export interface CrossDatasetRow {
  model: string;
  n: number[];
  median: number[];
  mean: number[];
  /** Mann-Whitney U between the first two datasets (NaN if either is empty). */
  pValue: number;
  effectSize: number;
}

export function crossDatasetSummary(
  records: readonly BenchmarkRecord[],
  q: { label: number; metric: SegMetricKey; datasets: string[] }
): CrossDatasetRow[] {
  const seg = latestPerPair(records.filter((r) => r.task === 'segmentation'));
  const models = [...new Set(seg.map(modelKey))].sort();
  const higherIsBetter = !LOWER_IS_BETTER.has(q.metric);
  return models.map((model) => {
    const raw = q.datasets.map((ds) =>
      seg
        .filter((r) => datasetKey(r) === canonicalDatasetId(ds) && modelKey(r) === model)
        .map((r) => metricOf(r, q.label, q.metric))
        .filter((v): v is number | 'fail' => v !== null)
    );
    const penalty = worstFinite(raw.flat(), higherIsBetter);
    const per = raw.map((xs) => xs.map((v) => (v === 'fail' ? penalty : v)).filter(Number.isFinite));
    const med = per.map((xs) => {
      if (!xs.length) return NaN;
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
    });
    const mean = per.map((xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN));
    const mw = per[0]?.length && per[1]?.length ? mannWhitneyU(per[0], per[1]) : null;
    return {
      model,
      n: per.map((xs) => xs.length),
      median: med,
      mean,
      pValue: mw ? mw.pValue : NaN,
      effectSize: mw ? mw.effectSize : NaN,
    };
  });
}

/** Parse NDJSON or a JSON array of tamias.benchmark.v1 records; drop ids already present. */
export function importRecordsText(text: string, existing: readonly BenchmarkRecord[]): BenchmarkRecord[] {
  const t = text.trim();
  const items: unknown[] = t.startsWith('[')
    ? (JSON.parse(t) as unknown[])
    : t
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown);
  const seen = new Set(existing.map((r) => r.id));
  const out: BenchmarkRecord[] = [];
  for (const it of items) {
    const r = it as BenchmarkRecord;
    if (!r || r.schema !== 'tamias.benchmark.v1') throw new Error('Not a tamias.benchmark.v1 record (schema mismatch).');
    if (typeof r.id !== 'string' || !r.model || !r.case) throw new Error('Record missing id/model/case.');
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
