import { describe, expect, it } from 'vitest';
import {
  friedmanTest,
  holmAdjust,
  pairwiseWilcoxonHolm,
  mannWhitneyU,
  nemenyiCriticalDifference,
  chi2Sf,
} from '../src/lib/stats/multi-model';

// cases × models (higher = better). Reference values: SciPy 1.x
const M = [
  [0.95, 0.93, 0.9, 0.96],
  [0.91, 0.92, 0.85, 0.94],
  [0.88, 0.9, 0.8, 0.91],
  [0.96, 0.95, 0.93, 0.97],
  [0.9, 0.87, 0.86, 0.93],
  [0.93, 0.93, 0.88, 0.95],
  [0.85, 0.86, 0.79, 0.9],
];

describe('multi-model statistics (SciPy-pinned)', () => {
  it('chi2 survival function', () => {
    expect(chi2Sf(3.841458820694124, 1)).toBeCloseTo(0.05, 8);
    expect(chi2Sf(19.173913043478265, 3)).toBeCloseTo(0.00025166923780174573, 10);
  });

  it('Friedman χ² with tie correction = scipy.stats.friedmanchisquare', () => {
    const r = friedmanTest(M);
    expect(r.statistic).toBeCloseTo(19.173913043478265, 9);
    expect(r.pValue).toBeCloseTo(0.00025166923780174573, 10);
    expect(r.df).toBe(3);
    // mean ranks, 1 = best (higher score)
    expect(r.meanRanks).toEqual([2.5, 2.5, 4, 1]);
  });

  it('Holm step-down adjustment (monotone, capped at 1)', () => {
    expect(holmAdjust([0.01, 0.04, 0.03, 0.5])).toEqual([0.04, 0.09, 0.09, 0.5]);
    expect(holmAdjust([0.9, 0.8])).toEqual([1, 1]);
  });

  it('pairwise Wilcoxon (approx, continuity) matches scipy for one pair and is Holm-adjusted', () => {
    const pw = pairwiseWilcoxonHolm(M, ['a', 'b', 'c', 'd']);
    expect(pw).toHaveLength(6);
    const ac = pw.find((p) => p.a === 'a' && p.b === 'c')!;
    expect(ac.pRaw).toBeCloseTo(0.022494271222449652, 6) // repo erf ≈1e-7;
    expect(ac.meanDiff).toBeCloseTo((0.95 + 0.91 + 0.88 + 0.96 + 0.9 + 0.93 + 0.85 - (0.9 + 0.85 + 0.8 + 0.93 + 0.86 + 0.88 + 0.79)) / 7, 10);
    for (const p of pw) expect(p.pHolm).toBeGreaterThanOrEqual(p.pRaw);
  });

  it('Mann-Whitney U (asymptotic, continuity) = scipy.stats.mannwhitneyu', () => {
    const a = [0.95, 0.91, 0.88, 0.96, 0.9, 0.93, 0.85];
    const b = [0.8, 0.85, 0.83, 0.9, 0.78, 0.88, 0.84, 0.86];
    const r = mannWhitneyU(a, b);
    expect(r.statistic).toBeCloseTo(50.5, 9);
    expect(r.pValue).toBeCloseTo(0.010684474670695589, 6);
    expect(r.medianA).toBeCloseTo(0.91, 9);
  });

  it('Mann-Whitney p is exactly 1 when |U − μ| < 0.5 (scipy parity)', () => {
    expect(mannWhitneyU([2, 5], [1, 3, 4, 6]).pValue).toBe(1);
    expect(mannWhitneyU([1, 2, 3], [1.5, 2.5]).pValue).toBe(1);
  });

  it('Nemenyi critical difference (Demšar 2006)', () => {
    // k=4, N=7: q0.05 = 2.569 → CD = 2.569*sqrt(4*5/(6*7))
    expect(nemenyiCriticalDifference(4, 7)).toBeCloseTo(2.569 * Math.sqrt(20 / 42), 6);
    expect(() => nemenyiCriticalDifference(11, 7)).toThrow();
  });

  it('rejects ragged input and NaNs', () => {
    expect(() => friedmanTest([[1, 2], [1]])).toThrow();
    expect(() => friedmanTest([[1, NaN, 2]])).toThrow();
  });
});
