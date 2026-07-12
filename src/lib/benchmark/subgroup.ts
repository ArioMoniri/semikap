/**
 * Subgroup analysis (Phase 3): stratify segmentation benchmark records by a
 * case-metadata field and report mean overlap/latency per subgroup.
 *
 * Pure functions, no DOM/network. Each record is first macro-averaged across
 * its per-label Dice/IoU/HD95 (ignoring NaN), then those per-record values are
 * averaged within each subgroup (again ignoring NaN). This mirrors the
 * case-then-group averaging used by `summarizeSegmentation` in ./types.
 */

import type { BenchmarkRecord } from './types';

/** Metadata field a set of records can be stratified by. */
export type SubgroupKey =
  | 'modality'
  | 'bodyPart'
  | 'contrast'
  | 'manufacturer'
  | 'sex'
  | 'ageBand';

/** One stratum: its bucket label, size, and mean metrics (NaN if none finite). */
export interface Subgroup {
  key: string;
  count: number;
  meanDice: number;
  meanIou: number;
  meanHd95Mm: number;
  meanInferMs: number;
}

/** Arithmetic mean of the finite entries; NaN when none are finite. */
function mean(nums: number[]): number {
  const valid = nums.filter((n) => Number.isFinite(n));
  return valid.length === 0 ? NaN : valid.reduce((s, v) => s + v, 0) / valid.length;
}

/** Bucket a patient age (years) into a coarse band; 'unknown' when undefined. */
function ageBand(years: number | undefined): string {
  if (years === undefined) return 'unknown';
  if (years < 30) return '<30';
  if (years < 50) return '30-49';
  if (years < 70) return '50-69';
  return '70+';
}

/** Resolve the grouping bucket for one record under the requested key. */
function bucketOf(rec: BenchmarkRecord, key: SubgroupKey): string {
  const meta = rec.case.meta;
  if (key === 'ageBand') return ageBand(meta?.ageYears);
  if (key === 'contrast') {
    const c = meta?.contrast;
    return c === undefined ? 'unknown' : c ? 'contrast' : 'non-contrast';
  }
  const value = meta?.[key];
  return value === undefined || value === '' ? 'unknown' : String(value);
}

/**
 * Group segmentation records by a metadata field and aggregate mean metrics.
 *
 * Only records with `task === 'segmentation'` and a `segmentation` array are
 * considered. Groups are returned sorted by bucket label ascending; each mean
 * ignores NaN and is NaN when no finite values contribute.
 */
export function subgroupSegmentation(
  records: BenchmarkRecord[],
  key: SubgroupKey,
): Subgroup[] {
  const groups = new Map<string, BenchmarkRecord[]>();
  for (const rec of records) {
    if (rec.task !== 'segmentation' || !rec.segmentation) continue;
    const bucket = bucketOf(rec, key);
    const arr = groups.get(bucket) ?? [];
    arr.push(rec);
    groups.set(bucket, arr);
  }

  const out: Subgroup[] = [];
  for (const [bucket, recs] of groups) {
    const dice = recs.map((r) => mean(r.segmentation!.map((s) => s.dice)));
    const iou = recs.map((r) => mean(r.segmentation!.map((s) => s.iou)));
    const hd95 = recs.map((r) => mean(r.segmentation!.map((s) => s.hd95Mm)));
    out.push({
      key: bucket,
      count: recs.length,
      meanDice: mean(dice),
      meanIou: mean(iou),
      meanHd95Mm: mean(hd95),
      meanInferMs: mean(recs.map((r) => r.runtime.inferMs)),
    });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}
