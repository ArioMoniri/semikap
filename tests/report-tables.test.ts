import { describe, expect, it } from 'vitest';
import { buildReportFiles, minWilcoxonP, bootstrapMedianCI } from '../src/lib/benchmark/report-tables';
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

describe('report-tables verifier fixes', () => {
  const build = buildReportFiles;
  it('minWilcoxonP(10) ≈ 0.0059 (> 0.05/45) — the power note is emitted', () => {
    expect(minWilcoxonP(10)).toBeCloseTo(0.0059, 3);
    expect(minWilcoxonP(10)).toBeGreaterThan(0.05 / 45);
  });
  it('bootstrap CI is deterministic and brackets the median', () => {
    const d = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
    const [lo, hi] = bootstrapMedianCI(d);
    expect(bootstrapMedianCI(d)).toEqual([lo, hi]);
    expect(lo).toBeLessThanOrEqual(0.04);
    expect(hi).toBeGreaterThanOrEqual(0.04);
  });
  it('neutralises spreadsheet formulas in text cells', () => {
    const files = build([rec('=HYPERLINK("x")', 'hcc', 'c1', 0.9), rec('B', 'hcc', 'c1', 0.8)]);
    expect(files['per_case.csv']).toContain(`"'=HYPERLINK(""x"")@1"`);
    expect(files['nemenyi_pairs.csv']).toBeDefined();
  });
});

describe('report provenance flags', () => {
  it('flags a model scored on its own training data with † and prints dataset/model notes', () => {
    const mk = (model: string, c: string, d: number) => ({ ...rec(model, 'msd-task03-liver', c, d) });
    const rs = ['a', 'b', 'c'].flatMap((c, i) => [
      mk('nnU-Net v2 Liver+Lesion (BAMF, LiTS)', c, 0.95 + i / 100),
      mk('LightningMedSeg3D UNet (BTCV, 14-class)', c, 0.9 + i / 100),
    ]);
    const files = buildReportFiles(rs);
    expect(files['REPORT.md']).toContain('nnU-Net v2 Liver+Lesion (BAMF, LiTS) †');
    expect(files['REPORT.md']).not.toContain('UNet (BTCV, 14-class) †');
    expect(files['REPORT.md']).toContain('resubstitution');
    expect(files['REPORT.md']).toContain('### Datasets and models');
    expect(files['summary.csv']).toContain(',true');
  });
});
