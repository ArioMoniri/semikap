/**
 * CSV / JSON export of benchmark records for the comparison table and for
 * external analysis (the "exportable report" of the roadmap Phase 1).
 * Everything here is pure string serialization.
 */

import type { BenchmarkRecord } from './types';

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  let s: string;
  if (typeof value === 'number') {
    s = Number.isFinite(value) ? String(value) : '';
  } else {
    s = String(value);
  }
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const SEG_COLUMNS = [
  'recordId',
  'model',
  'version',
  'caseId',
  'label',
  'dice',
  'iou',
  'precision',
  'recall',
  'f1',
  'hd95Mm',
  'assdMm',
  'volumeDiffMl',
  'inferMs',
  'provider',
  'createdAt',
] as const;

const CLS_COLUMNS = [
  'recordId',
  'model',
  'version',
  'caseId',
  'auroc',
  'auprc',
  'accuracy',
  'sensitivity',
  'specificity',
  'ppv',
  'npv',
  'f1',
  'brier',
  'ece',
  'n',
  'inferMs',
  'provider',
  'createdAt',
] as const;

/**
 * Long-format CSV: one row per (record, label) for segmentation, one row per
 * record for classification. Records of mixed tasks are grouped into two blocks
 * only if both present; otherwise a single header is emitted.
 */
export function recordsToCsv(records: BenchmarkRecord[]): string {
  const seg = records.filter((r) => r.task === 'segmentation' && r.segmentation);
  const cls = records.filter((r) => r.task === 'classification' && r.classification);
  const blocks: string[] = [];

  if (seg.length > 0) {
    const rows: string[] = [SEG_COLUMNS.join(',')];
    for (const r of seg) {
      for (const s of r.segmentation!) {
        rows.push(
          [
            r.id,
            r.model.name,
            r.model.version,
            r.case.caseId,
            s.label,
            round(s.dice),
            round(s.iou),
            round(s.precision),
            round(s.recall),
            round(s.f1),
            round(s.hd95Mm),
            round(s.assdMm),
            round(s.volumeDiffMl),
            round(r.runtime.inferMs),
            r.runtime.provider,
            r.createdAt,
          ]
            .map(csvCell)
            .join(',')
        );
      }
    }
    blocks.push(rows.join('\n'));
  }

  if (cls.length > 0) {
    const rows: string[] = [CLS_COLUMNS.join(',')];
    for (const r of cls) {
      const c = r.classification!;
      rows.push(
        [
          r.id,
          r.model.name,
          r.model.version,
          r.case.caseId,
          round(c.auroc),
          round(c.auprc),
          round(c.accuracy),
          round(c.sensitivity),
          round(c.specificity),
          round(c.ppv),
          round(c.npv),
          round(c.f1),
          round(c.brier),
          round(c.ece),
          c.n,
          round(r.runtime.inferMs),
          r.runtime.provider,
          r.createdAt,
        ]
          .map(csvCell)
          .join(',')
      );
    }
    blocks.push(rows.join('\n'));
  }

  return blocks.join('\n\n');
}

/** Pretty JSON array of the raw records. */
export function recordsToJson(records: BenchmarkRecord[]): string {
  return JSON.stringify(records, null, 2);
}

function round(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return n;
  return Math.round(n * 1e6) / 1e6;
}
