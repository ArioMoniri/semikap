import { describe, expect, it } from 'vitest';
import {
  caseReviewRows,
  sortRows,
  worstCases,
  type CaseReviewRow,
} from '../src/lib/benchmark/case-review';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';
import type { SegMetrics } from '../src/lib/metrics/segmentation';

function seg(partial: Partial<SegMetrics> & Pick<SegMetrics, 'label' | 'dice' | 'iou' | 'hd95Mm'>): SegMetrics {
  return {
    precision: 0,
    recall: 0,
    f1: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    refVoxels: 0,
    predVoxels: 0,
    volumeDiffMl: 0,
    volumetricSimilarity: 0,
    assdMm: 0,
    ...partial,
  };
}

function base(id: string, caseId: string): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id,
    profileId: 'p1',
    datasetName: 'ds',
    task: 'segmentation',
    model: { name: 'unet', version: '1', sha256: 'x' },
    case: { caseId, imageName: `${caseId}.nii` },
    runtime: { provider: 'wasm', inferMs: 100, totalMs: 100 },
    createdAt: '2026-01-01T00:00:00Z',
    appVersion: '0.11.0',
  };
}

// Record A (segmentation): dice [0.8, 0.6] -> 0.7; iou [0.5, 0.4] -> 0.45;
// hd95 [2, NaN] -> mean of finite = 2; inferMs 100.
const recA: BenchmarkRecord = {
  ...base('A', 'case-01'),
  segmentation: [
    seg({ label: 1, dice: 0.8, iou: 0.5, hd95Mm: 2 }),
    seg({ label: 2, dice: 0.6, iou: 0.4, hd95Mm: NaN }),
  ],
};

// Record B (segmentation): dice 0.9; iou 0.85; hd95 1; inferMs 200.
const recB: BenchmarkRecord = {
  ...base('B', 'case-02'),
  runtime: { provider: 'wasm', inferMs: 200, totalMs: 200 },
  segmentation: [seg({ label: 1, dice: 0.9, iou: 0.85, hd95Mm: 1 })],
};

// Record C (classification): auroc 0.75; inferMs 50.
const recC: BenchmarkRecord = {
  ...base('C', 'case-03'),
  task: 'classification',
  runtime: { provider: 'wasm', inferMs: 50, totalMs: 50 },
  classification: {
    auroc: 0.75,
    auprc: 0.7,
    brier: 0.1,
    ece: 0.05,
    n: 10,
    positives: 4,
    threshold: 0.5,
    accuracy: 0.8,
    precision: 0.8,
    recall: 0.8,
    f1: 0.8,
    tp: 4,
    fp: 1,
    tn: 4,
    fn: 1,
    sensitivity: 0.8,
    specificity: 0.8,
  } as BenchmarkRecord['classification'],
};

const records = [recA, recB, recC];

describe('caseReviewRows', () => {
  const rows = caseReviewRows(records);

  it('produces one row per record', () => {
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.recordId)).toEqual(['A', 'B', 'C']);
  });

  it('macro-averages segmentation metrics, ignoring NaN', () => {
    const a = rows[0]!;
    expect(a.dice).toBeCloseTo(0.7, 10);
    expect(a.iou).toBeCloseTo(0.45, 10);
    expect(a.hd95Mm).toBe(2); // [2, NaN] -> mean of finite = 2
    expect(a.auroc).toBeUndefined();
    expect(a.inferMs).toBe(100);
    expect(a.caseId).toBe('case-01');
    expect(a.model).toBe('unet');
    expect(a.task).toBe('segmentation');
  });

  it('carries classification auroc and leaves seg metrics undefined', () => {
    const c = rows[2]!;
    expect(c.auroc).toBe(0.75);
    expect(c.dice).toBeUndefined();
    expect(c.iou).toBeUndefined();
    expect(c.hd95Mm).toBeUndefined();
    expect(c.inferMs).toBe(50);
  });
});

describe('sortRows', () => {
  const rows = caseReviewRows(records);

  it('sorts by dice desc by default, undefined last', () => {
    const sorted = sortRows(rows, 'dice');
    // B (0.9), A (0.7), then C (undefined)
    expect(sorted.map((r) => r.recordId)).toEqual(['B', 'A', 'C']);
  });

  it('sorts by dice asc with undefined still last', () => {
    const sorted = sortRows(rows, 'dice', 'asc');
    // A (0.7), B (0.9), then C (undefined)
    expect(sorted.map((r) => r.recordId)).toEqual(['A', 'B', 'C']);
  });

  it('sorts by caseId asc by default', () => {
    const sorted = sortRows(rows, 'caseId');
    expect(sorted.map((r) => r.caseId)).toEqual(['case-01', 'case-02', 'case-03']);
  });

  it('sorts by caseId desc when requested', () => {
    const sorted = sortRows(rows, 'caseId', 'desc');
    expect(sorted.map((r) => r.caseId)).toEqual(['case-03', 'case-02', 'case-01']);
  });

  it('sorts by inferMs desc by default', () => {
    const sorted = sortRows(rows, 'inferMs');
    expect(sorted.map((r) => r.inferMs)).toEqual([200, 100, 50]);
  });

  it('is stable for equal values', () => {
    const tie: CaseReviewRow[] = [
      { recordId: '1', caseId: 'z', model: 'm', task: 't', dice: 0.5, inferMs: 10, createdAt: '' },
      { recordId: '2', caseId: 'z', model: 'm', task: 't', dice: 0.5, inferMs: 10, createdAt: '' },
      { recordId: '3', caseId: 'z', model: 'm', task: 't', dice: 0.5, inferMs: 10, createdAt: '' },
    ];
    expect(sortRows(tie, 'dice').map((r) => r.recordId)).toEqual(['1', '2', '3']);
  });

  it('does not mutate the input array', () => {
    const original = rows.map((r) => r.recordId);
    sortRows(rows, 'dice');
    expect(rows.map((r) => r.recordId)).toEqual(original);
  });
});

describe('worstCases', () => {
  const rows = caseReviewRows(records);

  it('returns lowest-dice rows first, excluding undefined', () => {
    const worst = worstCases(rows, 'dice');
    // A (0.7) worse than B (0.9); C excluded
    expect(worst.map((r) => r.recordId)).toEqual(['A', 'B']);
  });

  it('honors the top-n limit', () => {
    const worst = worstCases(rows, 'dice', 1);
    expect(worst.map((r) => r.recordId)).toEqual(['A']);
  });

  it('works on iou too', () => {
    const worst = worstCases(rows, 'iou');
    // A (0.45) worse than B (0.85)
    expect(worst.map((r) => r.recordId)).toEqual(['A', 'B']);
  });

  it('returns empty when no row has the metric', () => {
    const onlyCls = caseReviewRows([recC]);
    expect(worstCases(onlyCls, 'dice')).toEqual([]);
  });
});
