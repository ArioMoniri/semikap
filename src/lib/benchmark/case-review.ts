/**
 * Case-level review drilldown (doc §4.6): flatten benchmark records into one
 * row per record with headline metrics, then sort/filter for interactive
 * inspection. Pure functions — no DOM/network/PHI beyond what the records
 * already carry.
 */

import type { BenchmarkRecord } from './types';

/** One review row: a single record reduced to its headline metrics. */
export interface CaseReviewRow {
  recordId: string;
  caseId: string;
  model: string;
  task: string;
  /** Macro-mean Dice over segmentation labels (undefined for non-seg). */
  dice?: number;
  /** Macro-mean IoU over segmentation labels (undefined for non-seg). */
  iou?: number;
  /** Macro-mean HD95 in mm over segmentation labels (undefined for non-seg). */
  hd95Mm?: number;
  /** Classification AUROC (undefined for non-classification). */
  auroc?: number;
  inferMs: number;
  createdAt: string;
}

/** Mean of finite values only; undefined when no finite value is present. */
function meanFinite(nums: number[]): number | undefined {
  const valid = nums.filter((n) => Number.isFinite(n));
  return valid.length === 0 ? undefined : valid.reduce((s, v) => s + v, 0) / valid.length;
}

/**
 * Flatten records into review rows: segmentation records macro-average
 * Dice/IoU/HD95 over labels (ignoring NaN); classification records carry AUROC.
 */
export function caseReviewRows(records: BenchmarkRecord[]): CaseReviewRow[] {
  return records.map((r) => {
    const row: CaseReviewRow = {
      recordId: r.id,
      caseId: r.case.caseId,
      model: r.model.name,
      task: r.task,
      inferMs: r.runtime.inferMs,
      createdAt: r.createdAt,
    };
    if (r.segmentation && r.segmentation.length > 0) {
      row.dice = meanFinite(r.segmentation.map((s) => s.dice));
      row.iou = meanFinite(r.segmentation.map((s) => s.iou));
      row.hd95Mm = meanFinite(r.segmentation.map((s) => s.hd95Mm));
    }
    if (r.classification) {
      row.auroc = r.classification.auroc;
    }
    return row;
  });
}

/** Sortable column keys for {@link sortRows}. */
export type SortKey = 'dice' | 'iou' | 'hd95Mm' | 'auroc' | 'inferMs' | 'caseId';

/**
 * Stable-sort rows by `key`; undefined metric values always sort last
 * regardless of `dir`. Default `dir` is 'desc' for metrics, 'asc' for caseId.
 */
export function sortRows(rows: CaseReviewRow[], key: SortKey, dir?: 'asc' | 'desc'): CaseReviewRow[] {
  const direction: 'asc' | 'desc' = dir ?? (key === 'caseId' ? 'asc' : 'desc');
  const sign = direction === 'asc' ? 1 : -1;
  const indexed = rows.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => {
    if (key === 'caseId') {
      const cmp = a.row.caseId.localeCompare(b.row.caseId);
      return cmp !== 0 ? sign * cmp : a.i - b.i;
    }
    const av = a.row[key];
    const bv = b.row[key];
    const aMissing = av === undefined;
    const bMissing = bv === undefined;
    if (aMissing || bMissing) {
      if (aMissing && bMissing) return a.i - b.i;
      return aMissing ? 1 : -1;
    }
    if (av !== bv) return sign * (av - bv);
    return a.i - b.i;
  });
  return indexed.map((e) => e.row);
}

/**
 * Return the `n` (default 5) rows with the lowest `metric`, worst first; rows
 * with an undefined metric are excluded.
 */
export function worstCases(rows: CaseReviewRow[], metric: 'dice' | 'iou', n = 5): CaseReviewRow[] {
  return sortRows(
    rows.filter((r) => r[metric] !== undefined),
    metric,
    'asc',
  ).slice(0, n);
}
