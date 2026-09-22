import { describe, expect, it } from 'vitest';
import { recordsToMatrix, crossDatasetSummary, importRecordsText } from '../src/lib/benchmark/compare';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';

function rec(model: string, ds: string, caseId: string, dice: number, label = 1): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id: `${model}-${ds}-${caseId}-${label}`,
    profileId: 'default',
    datasetName: ds,
    task: 'segmentation',
    model: { name: model, version: '1', sha256: model.padEnd(64, '0') },
    case: { caseId, imageName: `${caseId}.nii.gz` },
    runtime: { provider: 'cpu', inferMs: 1, totalMs: 1 },
    segmentation: [
      { label, dice, iou: dice, precision: 1, recall: 1, f1: dice, tp: 1, fp: 0, fn: 0, refVoxels: 1, predVoxels: 1, volumeDiffMl: 0, volumetricSimilarity: 1, hd95Mm: 1 - dice, assdMm: 0 },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    appVersion: 'x',
  };
}

const recs = [
  rec('A', 'hcc', 'c1', 0.9), rec('B', 'hcc', 'c1', 0.8),
  rec('A', 'hcc', 'c2', 0.95), rec('B', 'hcc', 'c2', 0.85),
  rec('A', 'hcc', 'c3', 0.7), // B missing c3 → dropped (complete cases only)
  rec('A', 'msd', 'm1', 0.97), rec('B', 'msd', 'm1', 0.96),
];

describe('recordsToMatrix', () => {
  it('builds a complete-case cases × models matrix for one dataset/label/metric', () => {
    const m = recordsToMatrix(recs, { dataset: 'hcc', label: 1, metric: 'dice' });
    expect(m.models).toEqual(['A@1', 'B@1']);
    expect(m.cases).toEqual(['c1', 'c2']);
    expect(m.values).toEqual([[0.9, 0.8], [0.95, 0.85]]);
    expect(m.droppedCases).toEqual(['c3']);
  });
  it('lower-is-better metrics are flagged', () => {
    expect(recordsToMatrix(recs, { dataset: 'hcc', label: 1, metric: 'hd95Mm' }).higherIsBetter).toBe(false);
  });
  it('lists datasets when none is given', () => {
    expect(recordsToMatrix(recs, { label: 1, metric: 'dice' }).datasets).toEqual(['hcc', 'msd']);
  });
});

describe('crossDatasetSummary', () => {
  it('per model: median per dataset and Mann-Whitney between two datasets', () => {
    const s = crossDatasetSummary(recs, { label: 1, metric: 'dice', datasets: ['hcc', 'msd'] });
    const a = s.find((r) => r.model === 'A@1')!;
    expect(a.n).toEqual([3, 1]);
    expect(a.median[0]).toBeCloseTo(0.9, 9);
    expect(a.median[1]).toBeCloseTo(0.97, 9);
    expect(a.pValue).toBeGreaterThan(0);
  });
});

describe('importRecordsText', () => {
  it('accepts NDJSON and JSON arrays, dedupes by id, rejects foreign schemas', () => {
    const nd = recs.map((r) => JSON.stringify(r)).join('\n');
    expect(importRecordsText(nd, [])).toHaveLength(recs.length);
    expect(importRecordsText(JSON.stringify(recs), recs.slice(0, 2))).toHaveLength(recs.length - 2);
    expect(() => importRecordsText('{"schema":"other"}', [])).toThrow(/schema/);
  });
});
