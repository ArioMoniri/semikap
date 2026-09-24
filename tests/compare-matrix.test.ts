import { describe, expect, it } from 'vitest';
import { recordsToMatrix, crossDatasetSummary, importRecordsText, canonicalDatasetId, crossDatasetPairs } from '../src/lib/benchmark/compare';
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

describe('recordsToMatrix keying (verifier findings)', () => {
  it('does not merge the same caseId from two datasets when no dataset filter is given', () => {
    const r = [rec('A', 'hcc', 'c1', 0.9), rec('B', 'hcc', 'c1', 0.8), rec('A', 'msd', 'c1', 0.1), rec('B', 'msd', 'c1', 0.4)];
    const m = recordsToMatrix(r, { label: 1, metric: 'dice' });
    expect(m.cases).toEqual(['hcc/c1', 'msd/c1']);
    expect(m.values).toEqual([[0.9, 0.8], [0.1, 0.4]]);
  });
  it('model keys cannot collide through the separator', () => {
    const a = rec('a@b', 'hcc', 'c1', 0.9);
    const b = { ...rec('a', 'hcc', 'c1', 0.8), model: { name: 'a', version: 'b@c', sha256: 'x'.repeat(64) } };
    a.model.version = 'c';
    const m = recordsToMatrix([a, b], { dataset: 'hcc', label: 1, metric: 'dice' });
    expect(m.models).toHaveLength(2);
  });
});

describe('dataset id normalisation (runner folder names ↔ catalogue ids)', () => {
  it('maps hcc_tace_seg / msd_task03_liver to catalogue ids and merges them in matrices', () => {
    expect(canonicalDatasetId('hcc_tace_seg')).toBe('hcc-tace-seg');
    expect(canonicalDatasetId('msd_task03_liver')).toBe('msd-task03-liver');
    expect(canonicalDatasetId('custom set')).toBe('custom set');
    const r = [rec('A', 'hcc_tace_seg', 'c1', 0.9), rec('B', 'hcc-tace-seg', 'c1', 0.8)];
    const m = recordsToMatrix(r, { dataset: 'hcc-tace-seg', label: 1, metric: 'dice' });
    expect(m.datasets).toEqual(['hcc-tace-seg']);
    expect(m.values).toEqual([[0.9, 0.8]]);
  });
});

describe('verifier fixes: failures and re-runs', () => {
  const withHd = (r: BenchmarkRecord, dice: number, hd: number): BenchmarkRecord => ({
    ...r,
    segmentation: [{ ...r.segmentation![0]!, dice, hd95Mm: hd }],
  });
  it('a surface metric undefined by an empty prediction scores as the worst value, not a dropped case', () => {
    const rs = [
      withHd(rec('A', 'hcc', 'c1', 0.9), 0.9, 5),
      withHd(rec('B', 'hcc', 'c1', 0.8), 0.8, 9),
      withHd(rec('A', 'hcc', 'c2', 0.9), 0.9, 4),
      withHd(rec('B', 'hcc', 'c2', 0), 0, NaN), // B predicted nothing
    ];
    const m = recordsToMatrix(rs, { dataset: 'hcc', label: 1, metric: 'hd95Mm' });
    expect(m.cases).toEqual(['c1', 'c2']);
    expect(m.values[1]).toEqual([4, 9]);
    expect(m.failures).toEqual([0, 1]);
  });
  it('both masks empty (Dice 1, no surface) is not a failure — the case is not measurable', () => {
    const rs = [withHd(rec('A', 'hcc', 'c1', 1), 1, NaN), withHd(rec('B', 'hcc', 'c1', 1), 1, NaN)];
    expect(recordsToMatrix(rs, { dataset: 'hcc', label: 1, metric: 'hd95Mm' }).cases).toEqual([]);
  });
  it('crossDatasetSummary counts a re-run model/case once (latest wins)', () => {
    const rerun = { ...rec('A', 'hcc', 'c1', 0.5), id: 'rerun' };
    const s = crossDatasetSummary([...recs, rerun], { label: 1, metric: 'dice', datasets: ['hcc', 'msd'] });
    const a = s.find((r) => r.model === 'A@1')!;
    expect(a.n).toEqual([3, 1]);
    expect(a.median[0]).toBeCloseTo(0.7, 9); // {0.5, 0.95, 0.7}
  });
});

describe('crossDatasetPairs', () => {
  it('pairs raw datasets only, ignoring post-processed variants', () => {
    expect(crossDatasetPairs(['crlm', 'crlm [lcc]', 'hcc-tace-seg', 'hcc-tace-seg [fov]', 'msd-task03-liver'])).toEqual([
      ['crlm', 'hcc-tace-seg'],
      ['crlm', 'msd-task03-liver'],
      ['hcc-tace-seg', 'msd-task03-liver'],
    ]);
  });
  it('falls back to the first two keys when fewer than two raw datasets exist', () => {
    expect(crossDatasetPairs(['crlm', 'crlm [lcc]'])).toEqual([['crlm', 'crlm [lcc]']]);
    expect(crossDatasetPairs(['crlm'])).toEqual([]);
  });
});
