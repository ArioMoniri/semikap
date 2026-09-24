import { describe, expect, it } from 'vitest';
import {
  bootstrapRanks,
  canonicalModelOrder,
  covariatePoints,
  crossDatasetFigures,
  availableCovariates,
  displayModel,
  failureRows,
  kendallW,
  kruskalWallis,
  lesionStrips,
  minDetectableDiff,
  modelSlots,
  nemenyiCliques,
  nForDelta,
  pairedTPower,
  postprocessComparison,
  powerAnalysis,
  reportCrossPairs,
  runtimeGroups,
  shortModelName,
  spearman,
  tQuantile,
  tumourInclusionPoints,
} from '../src/lib/benchmark/figures';
import { volumeAgreementRows } from '../src/lib/benchmark/report-tables';
import { iccA1 } from '../src/lib/metrics/agreement';
import { blandAltman } from '../src/lib/plots/agreement';
import { tumourInclusion, scoreLiverTumourCase } from '../src/lib/metrics/label-groups';
import { setPngDpi } from '../src/lib/ui/figure-export';
import { createElement } from 'react';
import { CrossDatasetFigure } from '../src/components/plots/BenchmarkFigures';
import { renderFigureSvg } from '../src/components/plots/figure-registry';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';
import type { SegMetrics } from '../src/lib/metrics/segmentation';

function seg(label: number, dice: number, extra: Partial<SegMetrics> = {}): SegMetrics {
  return {
    label,
    dice,
    iou: dice / (2 - dice),
    precision: dice,
    recall: dice,
    f1: dice,
    tp: 0,
    fp: 0,
    fn: 0,
    refVoxels: 0,
    predVoxels: 0,
    volumeDiffMl: 0,
    volumetricSimilarity: 1,
    hd95Mm: 10,
    assdMm: 1,
    ...extra,
  } as SegMetrics;
}

let seq = 0;
function rec(p: {
  model: string;
  caseId: string;
  dataset?: string;
  segs: SegMetrics[];
  post?: string[];
  inferMs?: number;
  extra?: Partial<BenchmarkRecord>;
}): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id: `r${seq++}`,
    profileId: 'p',
    datasetName: p.dataset ?? 'hcc-tace-seg',
    task: 'segmentation',
    model: { name: p.model, version: '1.0.0', sha256: 'x' },
    case: { caseId: p.caseId, imageName: p.caseId, meta: { sliceThicknessMm: p.caseId.endsWith('1') ? 1 : 5 } },
    runtime: { provider: 'cpu', inferMs: p.inferMs ?? 1000, totalMs: 1000 },
    segmentation: p.segs,
    ...(p.post ? { postprocess: p.post } : {}),
    createdAt: '',
    appVersion: 't',
    ...p.extra,
  };
}

describe('model names + colours', () => {
  it('shortens catalogue names and keeps nnU-Net as one family', () => {
    expect(shortModelName('LightningMedSeg3D UNet (BTCV, 14-class)@1.0.0')).toBe('UNet');
    expect(shortModelName('LightningMedSeg3D Attention U-Net (BTCV, 14-class)@1.0.0')).toBe('Attention U-Net');
    expect(shortModelName('nnU-Net v2 Liver+Lesion (BAMF, LiTS, 3d_fullres, fold 0, 10-class)@2')).toBe('nnU-Net');
  });
  it('colour slot follows the model, not the set or rank', () => {
    const a = modelSlots(['UNet', 'VNet', 'Zeta']);
    const b = modelSlots(['VNet', 'nnU-Net', 'Alpha', 'Zeta', 'UNet']);
    expect(a.get('UNet')).toBe(b.get('UNet'));
    expect(a.get('VNet')).toBe(b.get('VNet'));
    expect(b.get('nnU-Net')).toBe(0);
    expect(new Set(b.values()).size).toBe(5);
    expect(canonicalModelOrder(['VNet@1', 'nnU-Net x@1', 'UNet@1'])).toEqual(['nnU-Net x@1', 'UNet@1', 'VNet@1']);
  });
  it('† marks a model on its own training data', () => {
    const tr = new Map([['nn@1', ['msd-task03-liver']]]);
    expect(displayModel('nn@1', 'msd-task03-liver [lcc]', tr)).toBe('nn †');
    expect(displayModel('nn@1', 'hcc-tace-seg', tr)).toBe('nn');
  });
});

describe('rank uncertainty + concordance', () => {
  const values = [
    [0.9, 0.8, 0.7],
    [0.91, 0.85, 0.6],
    [0.7, 0.9, 0.65],
    [0.95, 0.8, 0.75],
    [0.88, 0.86, 0.87],
  ];
  it('bootstrap ranks are deterministic for a fixed seed and bracket the observed rank', () => {
    const a = bootstrapRanks(values, true, 500, 7);
    const b = bootstrapRanks(values, true, 500, 7);
    expect(a).toEqual(b);
    expect(a.observed).toEqual([1, 2, 3]);
    for (let j = 0; j < 3; j++) {
      expect(a.lo[j]!).toBeLessThanOrEqual(a.observed[j]!);
      expect(a.hi[j]!).toBeGreaterThanOrEqual(a.observed[j]!);
      expect(a.freq[j]!.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    }
    expect(bootstrapRanks(values, true, 500, 8)).not.toEqual(a);
    // lower-is-better flips the ranking
    expect(bootstrapRanks(values, false, 10).observed).toEqual([3, 2, 1]);
  });
  it("Kendall's W: 1 for perfect agreement, known textbook value otherwise", () => {
    expect(kendallW([[3, 2, 1], [3, 2, 1], [3, 2, 1]], true)).toBeCloseTo(1, 12);
    // 3 raters × 4 objects, ranks [1,2,3,4] [2,3,1,4] [1,3,4,2] → sums 4, 8, 8, 10, S = 19, W = 12·19 / (9·60) = 0.4222
    expect(kendallW([[-1, -2, -3, -4], [-2, -3, -1, -4], [-1, -3, -3.5, -2.5]], true)).toBeCloseTo((12 * 19) / (9 * 60), 10);
  });
});

describe('Demšar critical-difference cliques', () => {
  it('groups consecutive models whose rank span ≤ CD, maximal groups only', () => {
    expect(nemenyiCliques([1, 1.5, 2.2, 4, 4.3, 6], 1.3)).toEqual([
      [0, 2],
      [3, 4],
    ]);
    expect(nemenyiCliques([1, 2, 3, 4], 1.5)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(nemenyiCliques([1, 5, 9], 1)).toEqual([]);
    expect(nemenyiCliques([1, 2, 3], 5)).toEqual([[0, 2]]);
  });
});

describe('power (paired t, noncentral)', () => {
  it('t quantile matches tables', () => {
    expect(tQuantile(0.975, 9)).toBeCloseTo(2.262157, 4);
    expect(tQuantile(0.975, 1000)).toBeCloseTo(1.962339, 3);
  });
  it('matches pwr.t.test(n = 20, d = 0.5, type = "paired") = 0.5645', () => {
    expect(pairedTPower(0.5, 1, 20, 0.05)).toBeCloseTo(0.5645, 3);
    expect(pairedTPower(0.8, 1, 15, 0.05)).toBeCloseTo(0.8213, 2); // pwr: 0.8213
  });
  it('MDD and n-for-Δ are inverse of each other', () => {
    const sd = 0.02;
    const alpha = 0.05 / 45;
    const n = nForDelta(0.01, sd, alpha);
    expect(pairedTPower(0.01, sd, n, alpha)).toBeGreaterThanOrEqual(0.8);
    expect(pairedTPower(0.01, sd, n - 1, alpha)).toBeLessThan(0.8);
    expect(minDetectableDiff(sd, n, alpha)).toBeLessThanOrEqual(0.01 + 1e-9);
  });
  it('MDD scales linearly with the SD (same bisection as on the raw SD)', () => {
    const alpha = 0.05 / 45;
    // reference: the plain bisection on the given SD
    const ref = (sd: number, n: number) => {
      let lo = 0;
      let hi = 50 * sd;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (pairedTPower(mid, sd, n, alpha) < 0.8) lo = mid;
        else hi = mid;
      }
      return hi;
    };
    for (const [sd, n] of [
      [0.02, 50],
      [0.137, 82],
      [7.5, 10],
      [0.001, 3],
    ] as const) {
      expect(minDetectableDiff(sd, n, alpha)).toBeCloseTo(ref(sd, n), 12);
      expect(minDetectableDiff(sd, n, alpha) / sd).toBeCloseTo(minDetectableDiff(1, n, alpha), 12);
    }
    expect(minDetectableDiff(0, 10, alpha)).toBeNaN();
    expect(minDetectableDiff(1, 1, alpha)).toBeNaN();
  });
  it('powerAnalysis over many same-shape matrices stays fast (report re-renders)', () => {
    const t0 = performance.now();
    for (let d = 0; d < 12; d++) {
      const v = Array.from({ length: 50 + d }, (_, i) => Array.from({ length: 10 }, (_, j) => 0.9 + (((i * 7 + j * 3 + d) % 11) - 5) * 0.003 * (1 + d)));
      expect(powerAnalysis(v)!.curve.length).toBeGreaterThan(10);
    }
    // was ≈ 3 s (40 bisection steps × 400-point integration per curve point, per SD, per dataset)
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it('powerAnalysis summarises pairwise SDs with Bonferroni α', () => {
    const v = Array.from({ length: 10 }, (_, i) => [0.9 + (i % 3) * 0.01, 0.9 + (i % 2) * 0.02, 0.85 + (i % 4) * 0.01]);
    const pa = powerAnalysis(v)!;
    expect(pa.pairs).toBe(3);
    expect(pa.alpha).toBeCloseTo(0.05 / 3, 12);
    expect(pa.sdQ25).toBeLessThanOrEqual(pa.sdMedian);
    expect(pa.curve.some((c) => c.n === 10)).toBe(true);
    const c = pa.curve;
    for (let i = 1; i < c.length; i++) expect(c[i]!.mdd).toBeLessThanOrEqual(c[i - 1]!.mdd + 1e-9);
  });
});

describe('association tests', () => {
  it('Spearman ρ on a monotone pair = 1, reversed = −1', () => {
    expect(spearman([1, 2, 3, 4, 5], [2, 4, 8, 16, 32]).rho).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]).rho).toBeCloseTo(-1, 12);
    const s = spearman([1, 2, 3, 4, 5, 6, 7, 8], [2, 1, 4, 3, 6, 5, 8, 7]);
    expect(s.rho).toBeCloseTo(0.9048, 3); // scipy.stats.spearmanr
    expect(s.p).toBeCloseTo(0.002, 3);
  });
  it('Kruskal–Wallis matches scipy (H = 7.2, p ≈ 0.0273)', () => {
    const r = kruskalWallis([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    expect(r.h).toBeCloseTo(7.2, 6);
    expect(r.p).toBeCloseTo(0.0273, 3);
  });
});

describe('record → figure data', () => {
  const recs: BenchmarkRecord[] = [];
  for (const [m, base] of [
    ['LightningMedSeg3D UNet (BTCV, 14-class)', 0.9],
    ['nnU-Net v2 Liver+Lesion (LiTS)', 0.95],
  ] as const)
    for (let c = 1; c <= 4; c++) {
      const ref = 1500 + c * 100;
      const pred = ref + (m.startsWith('nn') ? 10 : -50) * c;
      recs.push(
        rec({
          model: m,
          caseId: `HCC_00${c}`,
          segs: [
            seg(1, base - c * 0.02, { refMl: ref, predMl: pred, hd95Mm: c * 20 }),
            ...(m.startsWith('nn') ? [seg(2, 0.6, { refMl: c * 10, predMl: c * 9 })] : []),
          ],
          inferMs: c * 1000,
          extra: {
            tumourInclusion: m.startsWith('nn') ? 1 : 0.2 * c,
            ...(m.startsWith('nn')
              ? {
                  lesions: {
                    minVolumeMl: 0.5,
                    refLesions: 2,
                    tp: 1,
                    fn: 1,
                    fpComponents: 0,
                    refComponents: [
                      { volumeMl: 12, detected: true },
                      { volumeMl: 0.8, detected: false },
                      { volumeMl: 0.1, detected: false },
                    ],
                  },
                }
              : {}),
          },
        })
      );
      recs.push(rec({ model: m, caseId: `HCC_00${c}`, post: ['lcc'], segs: [seg(1, base - c * 0.02 + 0.01, { hd95Mm: c * 10 })] }));
    }

  it('volume agreement reuses blandAltman + iccA1 (whole liver and tumour)', () => {
    const rows = volumeAgreementRows(recs);
    const nn = rows.find((r) => r.model.startsWith('nnU-Net') && r.dataset === 'hcc-tace-seg')!;
    const pairs = [1, 2, 3, 4].map((c) => ({ ref: 1500 + c * 100, pred: 1500 + c * 110 }));
    expect(nn.bias).toBeCloseTo(blandAltman(pairs).bias, 9);
    expect(nn.icc).toBeCloseTo(iccA1(pairs.map((p) => [p.ref, p.pred])), 9);
    const tum = volumeAgreementRows(recs, 2);
    expect(tum).toHaveLength(1);
    expect(tum[0]!.bias).toBeCloseTo(-2.5, 9);
  });
  it('tumour inclusion points carry Dice and the case tumour volume', () => {
    const pts = tumourInclusionPoints(recs);
    expect(pts).toHaveLength(8);
    const u3 = pts.find((p) => p.model.includes('UNet') && p.caseId === 'HCC_003')!;
    expect(u3.inclusion).toBeCloseTo(0.6, 9);
    expect(u3.refTumourMl).toBe(30);
  });
  it('lesion strips expose every reference component and flag unscored ones', () => {
    const s = lesionStrips(recs);
    expect(s).toHaveLength(1);
    expect(s[0]!.lesions).toHaveLength(12);
    expect(s[0]!.lesions.filter((l) => !l.scored)).toHaveLength(4);
    expect(s[0]!.tp).toBe(4);
    expect(s[0]!.refLesions).toBe(8);
  });
  it('post-processing comparison pairs raw vs variant per model', () => {
    const b = postprocessComparison(recs, 1, 'hd95Mm');
    expect(b).toHaveLength(1);
    expect(b[0]!.variants).toEqual(['lcc']);
    const row = b[0]!.rows[0]!;
    expect(row.model.startsWith('nnU-Net')).toBe(true); // canonical order: nnU-Net first
    expect(row.raw).toBe(50);
    expect(row.variants[0]!.median).toBe(25);
    expect(row.variants[0]!.n).toBe(4);
  });
  it('runtime groups one inference per case (variants share it)', () => {
    const g = runtimeGroups(recs);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.seconds.length === 4)).toBe(true);
  });
  it('failures by Dice / HD95 thresholds', () => {
    const f = failureRows(recs, { diceBelow: 0.85, hd95Above: 50 });
    expect(f.map((r) => `${r.model.slice(0, 5)}|${r.caseId}|${r.dataset}`)).toContain('Light|HCC_004|hcc-tace-seg');
    expect(f.every((r) => r.dice < 0.85 || r.hd95 > 50)).toBe(true);
  });
  it('covariates: numeric meta + reference volumes', () => {
    const cov = availableCovariates(recs);
    expect(cov.map((c) => c.id)).toEqual(expect.arrayContaining(['refTumourMl', 'refLiverMl', 'meta.sliceThicknessMm']));
    const pts = covariatePoints(recs, cov.find((c) => c.id === 'meta.sliceThicknessMm')!, 1, 'dice');
    expect(pts.length).toBe(16);
    expect(new Set(pts.map((p) => p.x))).toEqual(new Set([1, 5]));
  });
});

describe('tumourInclusion metric', () => {
  it('fraction of reference tumour voxels predicted as whole liver', () => {
    const ref = new Uint8Array([1, 2, 2, 2, 2, 0]);
    const pred = new Uint8Array([6, 6, 0, 9, 0, 0]); // BTCV liver = 6; 9 = tumour label of another model
    expect(tumourInclusion(ref, pred, [6])).toBeCloseTo(0.25, 12);
    expect(tumourInclusion(ref, pred, [6, 9])).toBeCloseTo(0.5, 12);
    expect(tumourInclusion(new Uint8Array([1, 1]), new Uint8Array([6, 6]), [6])).toBeUndefined();
  });
  it('scoreLiverTumourCase reports it for liver-only models too', () => {
    const ref = new Uint8Array([1, 2, 2, 0]);
    const pred = new Uint8Array([6, 6, 0, 0]);
    const s = scoreLiverTumourCase(ref, pred, [4, 1, 1], [1, 1, 1], [{ id: 1, name: 'liver', refMembers: [1, 2], predMembers: [6] }]);
    expect(s.tumourInclusion).toBeCloseTo(0.5, 12);
    expect(s.lesions).toBeUndefined();
  });
});

describe('cross-dataset figures (every pair, for "Export all figures")', () => {
  const recs: BenchmarkRecord[] = [];
  for (const [m, base] of [
    ['LightningMedSeg3D UNet (BTCV, 14-class)', 0.9],
    ['nnU-Net v2 Liver+Lesion (LiTS)', 0.95],
  ] as const)
    for (let c = 1; c <= 3; c++) {
      recs.push(rec({ model: m, caseId: `HCC_00${c}`, segs: [seg(1, base - c * 0.02)] }));
      recs.push(rec({ model: m, caseId: `HCC_00${c}`, post: ['lcc'], segs: [seg(1, base - c * 0.01)] }));
      recs.push(rec({ model: m, caseId: `CRLM_00${c}`, dataset: 'crlm', segs: [seg(1, base - c * 0.03)] }));
      recs.push(rec({ model: m, caseId: `MSD_00${c}`, dataset: 'msd-task03-liver', segs: [seg(1, base - c * 0.04)] }));
    }
  const datasets = ['crlm', 'hcc-tace-seg', 'hcc-tace-seg [lcc]', 'msd-task03-liver'];

  it('pairs = raw-dataset pairs, then each post-processed variant vs its raw dataset', () => {
    expect(reportCrossPairs(datasets)).toEqual([
      ['crlm', 'hcc-tace-seg'],
      ['crlm', 'msd-task03-liver'],
      ['hcc-tace-seg', 'msd-task03-liver'],
      ['hcc-tace-seg', 'hcc-tace-seg [lcc]'],
    ]);
    // a variant whose raw dataset is absent gets no pair
    expect(reportCrossPairs(['crlm [fov]', 'hcc-tace-seg'])).toEqual([['crlm [fov]', 'hcc-tace-seg']]);
    // one raw dataset: the fallback pair is its variant, listed once
    expect(reportCrossPairs(['hcc-tace-seg', 'hcc-tace-seg [lcc]'])).toEqual([['hcc-tace-seg', 'hcc-tace-seg [lcc]']]);
  });

  it('one figure per pair, each with every model (canonical order) and exportable as SVG', async () => {
    const pairs = reportCrossPairs(datasets);
    const figs = crossDatasetFigures(recs, { label: 1, metric: 'dice', pairs });
    expect(figs.map((x) => x.pair)).toEqual(pairs);
    const st = { slots: modelSlots(recs.map((r) => shortModelName(r.model.name))), name: (m: string) => m };
    for (const fig of figs) {
      expect(fig.rows.map((r) => r.model)).toEqual(canonicalModelOrder(fig.rows.map((r) => r.model)));
      expect(fig.rows).toHaveLength(2);
      for (const r of fig.rows) expect(r.n).toEqual([3, 3]);
      const svg = await renderFigureSvg((t) => createElement(CrossDatasetFigure, { rows: fig.rows, datasets: fig.pair, metricLabel: 'Dice', st, theme: t }));
      expect(svg).toMatch(/^<\?xml[\s\S]*<svg xmlns=/);
    }
    // pairs without any scored model are left out
    expect(crossDatasetFigures(recs, { label: 2, metric: 'dice', pairs })).toEqual([]);
  });
});

describe('PNG dpi tag', () => {
  it('inserts a 300-dpi pHYs chunk after IHDR', () => {
    // minimal PNG: signature + IHDR(13) + IEND
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const ihdr = [0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde];
    const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82];
    const out = setPngDpi(new Uint8Array([...sig, ...ihdr, ...iend]), 300);
    const dv = new DataView(out.buffer);
    const p = 8 + 25;
    expect(String.fromCharCode(...out.subarray(p + 4, p + 8))).toBe('pHYs');
    expect(dv.getUint32(p + 8)).toBe(11811);
    expect(out.length).toBe(8 + 25 + 21 + 12);
    // idempotent: re-tagging replaces the chunk
    expect(setPngDpi(out, 300).length).toBe(out.length);
  });
});
