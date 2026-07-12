/**
 * Turn already-computed per-case results (the "Excel path") into synthetic
 * {@link BenchmarkRecord}s so the *existing* comparison table and statistical
 * panels work unchanged — no inference required.
 *
 * A user who already scored two models offline exports a CSV/TSV, imports it
 * via {@link parseSegResultsCsv}, and these helpers lift each row into a record
 * carrying just the metrics that were provided. Missing optional metrics are
 * stored as `NaN` so the aggregators skip them.
 *
 * Pure + deterministic (id generation is injectable for tests).
 */

import type { SegResultRow } from '../stats/results-import';
import type { SegMetrics } from '../metrics/segmentation';
import type { BenchmarkRecord } from './types';

/** Build a per-label metric entry from an imported row (only metrics given). */
function rowToSegMetrics(row: SegResultRow): SegMetrics {
  return {
    label: 1,
    dice: row.dice,
    iou: row.iou ?? NaN,
    precision: NaN,
    recall: NaN,
    f1: NaN,
    tp: NaN,
    fp: NaN,
    fn: NaN,
    refVoxels: NaN,
    predVoxels: NaN,
    volumeDiffMl: NaN,
    volumetricSimilarity: NaN,
    hd95Mm: row.hd95Mm ?? NaN,
    assdMm: row.assd ?? NaN,
  };
}

/** Options for {@link segRowsToRecords}. */
export interface ImportRecordOptions {
  /** Owning local profile id. */
  profileId: string;
  /** App version stamped onto each record. */
  appVersion: string;
  /** Human label for the imported dataset (e.g. the file name). */
  datasetName?: string;
  /** Deterministic id generator; defaults to a stable `imported:model:case`. */
  idFor?: (row: SegResultRow, index: number) => string;
  /** ISO timestamp stamped onto each record (defaults left to the caller). */
  createdAt?: string;
}

/**
 * Convert imported segmentation result rows into benchmark records — one record
 * per (case, model) row. The model version is fixed to `"imported"` so imported
 * results never collide with a locally-run model of the same name.
 *
 * @param rows - Rows from {@link parseSegResultsCsv}.
 * @param opts - Profile / version / labelling and id options.
 * @returns One {@link BenchmarkRecord} per input row, in input order.
 */
export function segRowsToRecords(
  rows: SegResultRow[],
  opts: ImportRecordOptions,
): BenchmarkRecord[] {
  const dataset = opts.datasetName ?? 'imported results';
  const createdAt = opts.createdAt ?? '1970-01-01T00:00:00.000Z';
  const idFor =
    opts.idFor ?? ((row: SegResultRow) => `imported:${row.model}:${row.caseId}`);

  return rows.map((row, i) => ({
    schema: 'tamias.benchmark.v1',
    id: idFor(row, i),
    profileId: opts.profileId,
    datasetName: dataset,
    task: 'segmentation',
    model: { name: row.model, version: 'imported', sha256: '' },
    case: { caseId: row.caseId, imageName: row.caseId, referenceName: dataset },
    runtime: { provider: 'imported', inferMs: NaN, totalMs: NaN },
    segmentation: [rowToSegMetrics(row)],
    createdAt,
    appVersion: opts.appVersion,
  }));
}
