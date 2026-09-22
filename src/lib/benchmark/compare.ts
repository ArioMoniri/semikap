/**
 * Shape benchmark records for multi-model (same dataset) and cross-dataset
 * (same model, different sources) statistics, plus NDJSON/JSON import so
 * results from the headless runner or another machine can be merged.
 */

import type { BenchmarkRecord } from './types';
import type { SegMetrics } from '../metrics/segmentation';
import { mannWhitneyU } from '../stats/multi-model';

export type SegMetricKey = 'dice' | 'iou' | 'hd95Mm' | 'assdMm' | 'volumetricSimilarity' | 'precision' | 'recall';
const LOWER_IS_BETTER = new Set<SegMetricKey>(['hd95Mm', 'assdMm']);

export function modelKey(r: BenchmarkRecord): string {
  return `${r.model.name}@${r.model.version}`;
}

function metricOf(r: BenchmarkRecord, label: number, metric: SegMetricKey): number | null {
  const m = r.segmentation?.find((s: SegMetrics) => s.label === label);
  const v = m ? m[metric] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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
  higherIsBetter: boolean;
}

export function recordsToMatrix(records: readonly BenchmarkRecord[], q: MatrixQuery): ScoreMatrix {
  const seg = records.filter((r) => r.task === 'segmentation');
  const datasets = [...new Set(seg.map((r) => r.datasetName))].sort();
  const inDs = q.dataset ? seg.filter((r) => r.datasetName === q.dataset) : seg;
  const models = [...new Set(inDs.map(modelKey))].sort();
  const byCase = new Map<string, Map<string, number>>();
  for (const r of inDs) {
    const v = metricOf(r, q.label, q.metric);
    if (v === null) continue;
    const row = byCase.get(r.case.caseId) ?? new Map<string, number>();
    row.set(modelKey(r), v);
    byCase.set(r.case.caseId, row);
  }
  const cases: string[] = [];
  const values: number[][] = [];
  const droppedCases: string[] = [];
  for (const c of [...byCase.keys()].sort()) {
    const row = byCase.get(c)!;
    if (models.every((m) => row.has(m))) {
      cases.push(c);
      values.push(models.map((m) => row.get(m)!));
    } else droppedCases.push(c);
  }
  return { datasets, models, cases, values, droppedCases, higherIsBetter: !LOWER_IS_BETTER.has(q.metric) };
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
  const models = [...new Set(records.filter((r) => r.task === 'segmentation').map(modelKey))].sort();
  return models.map((model) => {
    const per = q.datasets.map((ds) =>
      records
        .filter((r) => r.datasetName === ds && modelKey(r) === model)
        .map((r) => metricOf(r, q.label, q.metric))
        .filter((v): v is number => v !== null)
    );
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
