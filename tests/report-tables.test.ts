import { describe, expect, it } from 'vitest';
import { buildReportFiles } from '../src/lib/benchmark/report-tables';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';

function rec(model: string, ds: string, caseId: string, dice: number): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id: `${model}${ds}${caseId}`,
    profileId: 'p',
    datasetName: ds,
    task: 'segmentation',
    model: { name: model, version: '1', sha256: model },
    case: { caseId, imageName: caseId },
    runtime: { provider: 'cpu', inferMs: 1000, totalMs: 1 },
    segmentation: [{ label: 1, dice, iou: dice, precision: 1, recall: 1, f1: dice, tp: 1, fp: 0, fn: 0, refVoxels: 1, predVoxels: 1, volumeDiffMl: 0, volumetricSimilarity: 1, hd95Mm: 1 - dice, assdMm: 0 }],
    createdAt: '',
    appVersion: 'x',
  };
}

describe('buildReportFiles', () => {
  const recs = ['c1', 'c2', 'c3'].flatMap((c, i) => [rec('A', 'hcc', c, 0.9 + i / 100), rec('B', 'hcc', c, 0.8 + i / 100), rec('A', 'msd', c, 0.95), rec('B', 'msd', c, 0.9)]);
  const files = buildReportFiles(recs);
  it('emits the manuscript table set', () => {
    for (const f of ['per_case.csv', 'summary.csv', 'friedman.csv', 'REPORT.md', 'pairwise_hcc_whole_liver_dice.csv', 'cross_dataset_whole_liver_dice.csv']) {
      expect(files[f], f).toBeDefined();
    }
    expect(files['per_case.csv']!.split('\n')[0]).toContain('dataset,case,model');
  });
  it('REPORT.md has the Friedman line and methods', () => {
    expect(files['REPORT.md']).toMatch(/2 models × 3 complete cases\. Friedman χ²\(1\) = 3\.00/);
    expect(files['REPORT.md']).toMatch(/## Methods/);
  });
});
