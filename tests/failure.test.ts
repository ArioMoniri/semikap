import { describe, expect, it } from 'vitest';
import type { SegMetrics } from '../src/lib/metrics/segmentation';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';
import { classifyFailure, summarizeFailures } from '../src/lib/benchmark/failure';

/** Build a full SegMetrics with overridable fields. */
function seg(partial: Partial<SegMetrics> & { label: string }): SegMetrics {
  return {
    dice: 0.9,
    iou: 0.8,
    hd95Mm: 3,
    assdMm: 1,
    volumeDiffMl: 0,
    refVoxels: 100,
    predVoxels: 100,
    tp: 90,
    fp: 10,
    fn: 10,
    precision: 0.9,
    recall: 0.9,
    f1: 0.9,
    volumetricSimilarity: 0.95,
    ...partial,
  };
}

/** Build a segmentation BenchmarkRecord with a given id + label metrics. */
function rec(id: string, segmentation: SegMetrics[]): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id,
    profileId: 'p1',
    datasetName: 'ds',
    task: 'segmentation',
    model: { name: 'm', version: '1', sha256: 'abc' },
    case: { caseId: 'c1', imageName: 'img.nii' },
    runtime: { provider: 'wasm', inferMs: 10, totalMs: 20 },
    segmentation,
    createdAt: '2026-01-01T00:00:00Z',
    appVersion: '0.12.0',
  };
}

describe('classifyFailure', () => {
  it('flags empty-prediction when every label has predVoxels === 0', () => {
    const r = rec('r1', [
      seg({ label: 'liver', predVoxels: 0 }),
      seg({ label: 'spleen', predVoxels: 0 }),
    ]);
    expect(classifyFailure(r)).toEqual({
      recordId: 'r1',
      kind: 'empty-prediction',
      detail: 'all labels have predVoxels === 0',
    });
  });

  it('flags empty-reference when every label has refVoxels === 0 (but some pred present)', () => {
    const r = rec('r2', [
      seg({ label: 'liver', refVoxels: 0, predVoxels: 50 }),
      seg({ label: 'spleen', refVoxels: 0, predVoxels: 0 }),
    ]);
    expect(classifyFailure(r).kind).toBe('empty-reference');
  });

  it('flags nan-metric when a label dice is NaN', () => {
    const r = rec('r3', [seg({ label: 'liver', dice: NaN })]);
    const flag = classifyFailure(r);
    expect(flag.kind).toBe('nan-metric');
    expect(flag.detail).toContain('liver');
  });

  it('flags nan-metric when a label hd95Mm is NaN', () => {
    const r = rec('r4', [seg({ label: 'kidney', hd95Mm: NaN })]);
    expect(classifyFailure(r).kind).toBe('nan-metric');
  });

  it('returns none for a good record', () => {
    const r = rec('r5', [seg({ label: 'liver' })]);
    expect(classifyFailure(r)).toEqual({ recordId: 'r5', kind: 'none' });
  });

  it('returns none when there are no segmentation labels', () => {
    const r = rec('r6', []);
    expect(classifyFailure(r).kind).toBe('none');
    const noSeg = { ...rec('r7', []) };
    delete (noSeg as { segmentation?: SegMetrics[] }).segmentation;
    expect(classifyFailure(noSeg).kind).toBe('none');
  });

  it('treats absent voxel counts as 0 (empty-prediction)', () => {
    const bare = { label: 'x', dice: 0.5, iou: 0.4, hd95Mm: 2 } as unknown as SegMetrics;
    const r = rec('r8', [bare]);
    expect(classifyFailure(r).kind).toBe('empty-prediction');
  });

  it('prioritizes empty-prediction over a NaN metric', () => {
    const r = rec('r9', [seg({ label: 'liver', predVoxels: 0, dice: NaN })]);
    expect(classifyFailure(r).kind).toBe('empty-prediction');
  });
});

describe('summarizeFailures', () => {
  it('returns zeros for an empty list', () => {
    expect(summarizeFailures([])).toEqual({
      total: 0,
      failed: 0,
      byKind: {},
      failureRate: 0,
    });
  });

  it('computes counts and rate over a mix', () => {
    const records = [
      rec('a', [seg({ label: 'liver' })]), // none
      rec('b', [seg({ label: 'liver' })]), // none
      rec('c', [seg({ label: 'liver', predVoxels: 0 })]), // empty-prediction
      rec('d', [seg({ label: 'liver', dice: NaN })]), // nan-metric
    ];
    const summary = summarizeFailures(records);
    expect(summary.total).toBe(4);
    expect(summary.failed).toBe(2);
    expect(summary.byKind).toEqual({
      none: 2,
      'empty-prediction': 1,
      'nan-metric': 1,
    });
    expect(summary.failureRate).toBeCloseTo(0.5, 10);
  });
});
