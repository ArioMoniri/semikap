import { describe, expect, it } from 'vitest';
import { applyPostprocess, parsePostprocess, FOV_HU_THRESHOLD } from '../src/lib/metrics/postprocess';
import { segmentationMetrics, surfaceMetrics } from '../src/lib/metrics/segmentation';
import { lesionDetection, labelComponents26 } from '../src/lib/metrics/lesions';
import { iccA1, wilsonInterval } from '../src/lib/metrics/agreement';
import { scoreLiverTumourCase } from '../src/lib/metrics/label-groups';
import { scoreLesions } from '../src/lib/metrics/score';
import { datasetKey, recordsToMatrix } from '../src/lib/benchmark/compare';
import { buildReportFiles, volumeAgreementRows, lesionDetectionRows } from '../src/lib/benchmark/report-tables';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';

type D = [number, number, number];

describe('parsePostprocess', () => {
  it('parses none / single / combined options in canonical order', () => {
    expect(parsePostprocess('none')).toEqual([]);
    expect(parsePostprocess('')).toEqual([]);
    expect(parsePostprocess('lcc')).toEqual(['lcc']);
    expect(parsePostprocess('lcc,fov')).toEqual(['fov', 'lcc']);
    expect(() => parsePostprocess('bogus')).toThrow(/postprocess/);
  });
});

describe('applyPostprocess', () => {
  const dims: D = [6, 1, 1];
  it('fov zeroes every prediction where the input CT is padding (HU <= -1500)', () => {
    const pred = new Uint8Array([1, 1, 3, 1, 2, 0]);
    const ct = new Int16Array([0, -2048, -3024, FOV_HU_THRESHOLD, -1000, 0]);
    expect(Array.from(applyPostprocess(pred, ct, dims, [1, 2], ['fov']))).toEqual([1, 0, 0, 0, 2, 0]);
  });
  it('lcc keeps the largest whole-liver component, leaving other labels untouched', () => {
    // liver 1 + tumour 2 form a 3-voxel blob; lone liver voxel at x=5; label 7 (spleen) unaffected
    const pred = new Uint8Array([1, 2, 1, 7, 0, 1]);
    expect(Array.from(applyPostprocess(pred, null, dims, [1, 2], ['lcc']))).toEqual([1, 2, 1, 7, 0, 0]);
  });
  it('fov runs before lcc and does not mutate the input', () => {
    const pred = new Uint8Array([1, 1, 0, 1, 1, 1]);
    const ct = new Int16Array([0, 0, 0, 0, -2048, 0]);
    const out = applyPostprocess(pred, ct, dims, [1], ['fov', 'lcc']);
    expect(Array.from(out)).toEqual([1, 1, 0, 0, 0, 0]);
    expect(pred[4]).toBe(1);
  });
  it('fov requires a CT on the prediction grid', () => {
    expect(() => applyPostprocess(new Uint8Array(6), new Int16Array(5), dims, [1], ['fov'])).toThrow(/CT/);
  });
});

describe('normalised surface Dice', () => {
  const dims: D = [10, 1, 1];
  it('is 1 when surfaces coincide within τ and drops when they do not', () => {
    const ref = new Uint8Array(10);
    const pred = new Uint8Array(10);
    ref.fill(1, 2, 5); // surface voxels 2,4 (3 is interior along x but border in y/z → all surface)
    pred.fill(1, 3, 6);
    const s = surfaceMetrics(ref, pred, dims, [1, 1, 1]);
    expect(s.nsd2Mm).toBe(1); // every surface voxel within 1 mm of the other surface
    const far = new Uint8Array(10);
    far.fill(1, 8, 10);
    const t = surfaceMetrics(ref, far, dims, [1, 1, 1]);
    // ref {2,3,4} → nearest 8 at 6,5,4 mm; far {8,9} → 4,5 mm: τ=5 → 2+2 of 5 within
    expect(t.nsd2Mm).toBe(0);
    expect(t.nsd5Mm).toBeCloseTo(4 / 5, 10);
  });
  it('segmentationMetrics carries NSD, and volumes in mL', () => {
    const ref = new Uint8Array(10).fill(1, 0, 4);
    const pred = new Uint8Array(10).fill(1, 0, 6);
    const m = segmentationMetrics(ref, pred, dims, [2, 1, 1], 1);
    expect(m.refMl).toBeCloseTo(0.008, 10);
    expect(m.predMl).toBeCloseTo(0.012, 10);
    expect(m.nsd5Mm).toBe(1);
    const empty = segmentationMetrics(new Uint8Array(10), new Uint8Array(10), dims, [1, 1, 1], 1);
    expect(empty.nsd2Mm).toBe(1);
    const miss = segmentationMetrics(ref, new Uint8Array(10), dims, [1, 1, 1], 1);
    expect(miss.nsd2Mm).toBe(0);
    expect(segmentationMetrics(ref, pred, dims, [1, 1, 1], 1, { surface: false }).nsd2Mm).toBeUndefined();
  });
});

describe('lesion detection', () => {
  it('26-connected components join diagonal voxels', () => {
    const m = new Uint8Array([1, 0, 0, 1]); // 2x2x1 diagonal
    const { count, sizes } = labelComponents26(m, [2, 2, 1]);
    expect(count).toBe(1);
    expect(sizes[1]).toBe(2);
  });
  it('counts detected / missed reference lesions and false-positive components ≥ min volume', () => {
    const dims: D = [12, 1, 1];
    // ref lesions: A = 0..1 (2 vox), B = 4..5, tiny C = 8 (1 vox, below min)
    const ref = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0]);
    // pred: hits A, misses B, touches tiny C, FP blob 10..11 (2 vox)
    const pred = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1]);
    // voxel = 1 mm³ → min volume 0.002 mL = 2 voxels
    const r = lesionDetection(ref, pred, dims, [1, 1, 1], 0.002);
    expect(r).toMatchObject({ minVolumeMl: 0.002, refLesions: 2, tp: 1, fn: 1, fpComponents: 1 });
    // every reference component, largest first (ties keep scan order), tiny C included
    expect(r.refComponents).toEqual([
      { volumeMl: 0.002, detected: true },
      { volumeMl: 0.002, detected: false },
      { volumeMl: 0.001, detected: true },
    ]);
  });
  it('scoreLiverTumourCase returns segmentation + lesions only for tumour models', () => {
    const dims: D = [4, 1, 1];
    const ref = new Uint8Array([1, 2, 2, 0]);
    const pred = new Uint8Array([8, 9, 9, 0]);
    const groups = [
      { id: 1, name: 'liver', refMembers: [1, 2], predMembers: [8, 9] },
      { id: 2, name: 'tumour', refMembers: [2], predMembers: [9] },
    ];
    const s = scoreLiverTumourCase(ref, pred, dims, [1, 1, 1], groups, { minLesionMl: 0 });
    for (const m of s.segmentation) expect(m.dice).toBeCloseTo(1, 6);
    expect(s.lesions).toMatchObject({ refLesions: 1, tp: 1, fn: 0, fpComponents: 0 });
    expect(scoreLiverTumourCase(ref, pred, dims, [1, 1, 1], groups.slice(0, 1)).lesions).toBeUndefined();
  });
  it('scoreLesions maps model labels and is undefined without a tumour class', () => {
    const grid = { dims: [4, 1, 1] as const, spacing: [10, 10, 10] as const }; // 1 mL voxels
    const refMask = new Uint8Array([1, 2, 0, 2]);
    const predMask = new Uint8Array([8, 9, 0, 0]);
    const inp = { refMask, refGrid: grid, predMask, predGrid: grid };
    expect(scoreLesions({ ...inp, predLabels: { 8: 'liver', 9: 'liver tumor' } })).toMatchObject({ minVolumeMl: 0.5, refLesions: 2, tp: 1, fn: 1, fpComponents: 0 });
    expect(scoreLesions({ ...inp, predLabels: { 8: 'liver' } })).toBeUndefined();
  });
});

describe('agreement statistics', () => {
  it('ICC(A,1) reproduces Shrout & Fleiss (1979) Table 2: ICC(2,1) = 0.29', () => {
    const x = [
      [9, 2, 5, 8],
      [6, 1, 3, 2],
      [8, 4, 6, 8],
      [7, 1, 2, 6],
      [10, 5, 6, 9],
      [6, 2, 4, 7],
    ];
    expect(iccA1(x)).toBeCloseTo(0.2898, 3);
    expect(iccA1([[1, 1], [2, 2], [3, 3]])).toBeCloseTo(1, 10);
    expect(iccA1([[1, 2]])).toBeNaN();
  });
  it('Wilson 95% interval', () => {
    const [lo, hi] = wilsonInterval(8, 10);
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
    expect(wilsonInterval(0, 0).every(Number.isNaN)).toBe(true);
  });
});

function rec(
  model: string,
  caseId: string,
  over: Partial<BenchmarkRecord> = {},
  seg: Partial<BenchmarkRecord['segmentation'] extends (infer T)[] | undefined ? T : never> = {}
): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id: `${model}-${caseId}-${JSON.stringify(over.postprocess ?? [])}`,
    profileId: 'p',
    datasetName: 'hcc_tace_seg',
    task: 'segmentation',
    model: { name: model, version: '1', sha256: model },
    case: { caseId, imageName: caseId },
    runtime: { provider: 'cpu', inferMs: 1000, totalMs: 1 },
    segmentation: [
      { label: 1, dice: 0.9, iou: 0.8, precision: 1, recall: 1, f1: 0.9, tp: 1, fp: 0, fn: 0, refVoxels: 1000, predVoxels: 1100, volumeDiffMl: 100, volumetricSimilarity: 1, hd95Mm: 3, assdMm: 1, ...seg },
    ],
    createdAt: '',
    appVersion: 'x',
    ...over,
  };
}

describe('post-processing is part of the dataset key', () => {
  it('records with different post-processing never share a comparison matrix', () => {
    expect(datasetKey(rec('A', 'c1'))).toBe('hcc-tace-seg');
    expect(datasetKey(rec('A', 'c1', { postprocess: ['fov', 'lcc'] }))).toBe('hcc-tace-seg [fov+lcc]');
    const rs = ['c1', 'c2'].flatMap((c) => [rec('A', c), rec('A', c, { postprocess: ['lcc'] }, { dice: 0.95 }), rec('B', c)]);
    const m = recordsToMatrix(rs, { label: 1, metric: 'dice' });
    expect(m.datasets).toEqual(['hcc-tace-seg', 'hcc-tace-seg [lcc]']);
    const base = recordsToMatrix(rs, { dataset: 'hcc-tace-seg', label: 1, metric: 'dice' });
    expect(base.values.flat()).toEqual([0.9, 0.9, 0.9, 0.9]);
  });
});

describe('report: NSD, lesion detection, volume agreement, methods', () => {
  const cases = ['c1', 'c2', 'c3'];
  const withNew = cases.flatMap((c, i) => [
    rec('A', c, { postprocess: ['lcc'], lesions: { minVolumeMl: 0.5, refLesions: 2, tp: 1 + (i % 2), fn: 1 - (i % 2), fpComponents: i } }, {
      nsd2Mm: 0.8 + i / 100,
      nsd5Mm: 0.9,
      refMl: 1000 + 100 * i,
      predMl: 1010 + 100 * i,
    }),
    rec('B', c, { postprocess: ['lcc'] }, { nsd2Mm: 0.7 + i / 50, nsd5Mm: 0.85, refMl: 1000 + 100 * i, predMl: 1100 + 90 * i }),
  ]);
  const files = buildReportFiles(withNew);
  it('per_case/summary carry NSD and the Friedman analysis covers it', () => {
    expect(files['per_case.csv']!.split('\n')[0]).toContain('nsd2Mm,nsd5Mm');
    expect(files['summary.csv']).toContain('hcc-tace-seg [lcc],whole_liver,nsd2Mm');
    expect(files['REPORT.md']).toContain('## hcc-tace-seg [lcc] — whole_liver — nsd2Mm');
  });
  it('lesion detection: pooled sensitivity with Wilson CI and FP per case', () => {
    const rows = lesionDetectionRows(withNew);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dataset: 'hcc-tace-seg [lcc]', model: 'A@1', cases: 3, tp: 4, fn: 2, fpPerCase: 1 });
    expect(rows[0]!.sensitivity).toBeCloseTo(4 / 6, 10);
    expect(files['lesion_detection.csv']).toBeDefined();
    expect(files['REPORT.md']).toContain('## Lesion detection');
  });
  it('volume agreement: Bland–Altman + ICC per model × dataset', () => {
    const rows = volumeAgreementRows(withNew);
    const a = rows.find((r) => r.model === 'A@1')!;
    expect(a.n).toBe(3);
    expect(a.bias).toBeCloseTo(10, 10);
    expect(a.loaLow).toBeCloseTo(10, 10);
    expect(a.icc).toBeGreaterThan(0.99);
    expect(files['volume_agreement.csv']!.split('\n')[0]).toBe('dataset,model,n,mean_ref_ml,mean_pred_ml,bias_ml,sd_diff_ml,loa_low_ml,loa_high_ml,icc_a1');
    expect(files['REPORT.md']).toContain('## Volume agreement');
  });
  it('methods state the post-processing applied', () => {
    expect(files['REPORT.md']).toMatch(/Post-processing: largest 3-D connected component/);
    expect(files['REPORT.md']).not.toMatch(/no post-processing \(no largest/);
  });
  it('old records (no new fields) still analyse; new sections are omitted; volumes derived from volumeDiffMl', () => {
    const old = cases.flatMap((c) => [rec('A', c), rec('B', c, {}, { dice: 0.8 })]);
    const f = buildReportFiles(old);
    expect(f['lesion_detection.csv']).toBeUndefined();
    expect(f['REPORT.md']).not.toContain('## Lesion detection');
    expect(f['REPORT.md']).not.toContain('nsd2Mm');
    expect(f['REPORT.md']).toMatch(/no post-processing/i);
    // 1000 → 1100 voxels with a 100 mL difference ⇒ 1 mL voxels
    const v = volumeAgreementRows(old);
    expect(v[0]!.bias).toBeCloseTo(100, 10);
  });
});
