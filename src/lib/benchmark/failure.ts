/**
 * Failure-mode capture + summary (doc §4.5 metric engine "failure-mode
 * metrics"). A benchmark run can produce a *technically valid* record that is
 * nonetheless a degenerate/failed evaluation — the model predicted nothing, the
 * reference mask was empty, or a metric came back NaN. This module classifies
 * each record into a single dominant failure kind and aggregates the rates so
 * the UI can surface "N% of cases failed, mostly empty-prediction".
 *
 * Pure: no DOM, no network, no I/O. Inspects only the record's segmentation
 * metrics.
 */

import type { BenchmarkRecord } from './types';

/**
 * The mutually-exclusive failure buckets a record can fall into. `'none'` means
 * the record is a well-formed, non-degenerate evaluation.
 */
export type FailureKind =
  | 'empty-prediction'
  | 'empty-reference'
  | 'grid-mismatch'
  | 'nan-metric'
  | 'runtime-error'
  | 'none';

/** A single record's failure classification, with optional human-readable detail. */
export interface FailureFlag {
  recordId: string;
  kind: FailureKind;
  detail?: string;
}

/**
 * Classify one benchmark record's dominant failure mode. Contract: inspects
 * `record.segmentation`; if every label has `predVoxels === 0` returns
 * `'empty-prediction'`; else if every label has `refVoxels === 0` returns
 * `'empty-reference'`; else if any label's `dice` or `hd95Mm` is NaN returns
 * `'nan-metric'`; otherwise `'none'`. Absent voxel counts are treated as 0. A
 * record with no segmentation labels is `'none'` (nothing to classify).
 */
export function classifyFailure(record: BenchmarkRecord): FailureFlag {
  const segs = record.segmentation ?? [];
  if (segs.length === 0) {
    return { recordId: record.id, kind: 'none' };
  }

  const allPredEmpty = segs.every((s) => (s.predVoxels ?? 0) === 0);
  if (allPredEmpty) {
    return {
      recordId: record.id,
      kind: 'empty-prediction',
      detail: 'all labels have predVoxels === 0',
    };
  }

  const allRefEmpty = segs.every((s) => (s.refVoxels ?? 0) === 0);
  if (allRefEmpty) {
    return {
      recordId: record.id,
      kind: 'empty-reference',
      detail: 'all labels have refVoxels === 0',
    };
  }

  const nanLabel = segs.find((s) => Number.isNaN(s.dice) || Number.isNaN(s.hd95Mm));
  if (nanLabel) {
    return {
      recordId: record.id,
      kind: 'nan-metric',
      detail: `label "${nanLabel.label}" has a NaN dice/hd95`,
    };
  }

  return { recordId: record.id, kind: 'none' };
}

/** Aggregate failure statistics across a set of records. */
export interface FailureSummary {
  total: number;
  failed: number;
  byKind: Record<string, number>;
  failureRate: number;
}

/**
 * Summarize failure modes over many records. Contract: `total` = record count;
 * a record counts as `failed` when its `classifyFailure` kind !== `'none'`;
 * `byKind` maps every observed kind (including `'none'`) to its count;
 * `failureRate` = failed / total, and is 0 when `records` is empty.
 */
export function summarizeFailures(records: BenchmarkRecord[]): FailureSummary {
  const byKind: Record<string, number> = {};
  let failed = 0;
  for (const record of records) {
    const { kind } = classifyFailure(record);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (kind !== 'none') failed += 1;
  }
  const total = records.length;
  return {
    total,
    failed,
    byKind,
    failureRate: total === 0 ? 0 : failed / total,
  };
}
