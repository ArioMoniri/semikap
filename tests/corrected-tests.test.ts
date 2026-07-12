import { describe, expect, it } from 'vitest';
import {
  logGamma,
  ibeta,
  studentTCdf,
  studentTTwoTailedP,
  resampledTtest,
  kfoldTtest,
  repeatedKfoldTtest,
  pairedDifferences,
} from '../src/lib/stats/corrected-tests';

// All reference values computed with SciPy (scipy.stats.t / scipy.stats.beta).

describe('special functions', () => {
  it('logGamma matches known factorials', () => {
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 6); // Γ(5)=4!
    expect(Math.exp(logGamma(1))).toBeCloseTo(1, 9);
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 8); // Γ(1/2)=√π
  });

  it('ibeta matches SciPy beta CDF', () => {
    expect(ibeta(0.5, 2, 3)).toBeCloseTo(0.6875, 9); // I_0.5(2,3)
    expect(ibeta(0, 2, 3)).toBe(0);
    expect(ibeta(1, 2, 3)).toBe(1);
  });
});

describe('Student-t p-values vs SciPy', () => {
  it('two-tailed p-values', () => {
    expect(studentTTwoTailedP(2.0, 10)).toBeCloseTo(0.0733880348, 8);
    expect(studentTTwoTailedP(2.228, 10)).toBeCloseTo(0.0500117718, 8);
    expect(studentTTwoTailedP(1.0, 1)).toBeCloseTo(0.5, 8); // Cauchy
    expect(studentTTwoTailedP(0.0, 5)).toBeCloseTo(1.0, 9);
    expect(studentTTwoTailedP(3.0, 20)).toBeCloseTo(0.0070758988, 8);
  });
  it('is symmetric in t', () => {
    expect(studentTTwoTailedP(-2.0, 10)).toBeCloseTo(studentTTwoTailedP(2.0, 10), 12);
  });
  it('CDF matches SciPy', () => {
    expect(studentTCdf(2.0, 10)).toBeCloseTo(0.9633059826, 8);
    expect(studentTCdf(-2.0, 10)).toBeCloseTo(1 - 0.9633059826, 8);
    expect(studentTCdf(1.0, 1)).toBeCloseTo(0.75, 8);
  });
});

const D = [0.05, 0.02, 0.03, -0.01, 0.04, 0.02, 0.06, 0.0, 0.03, 0.01]; // mean 0.025, var 0.00047222

describe('corrected tests vs SciPy worked examples', () => {
  it('resampledTtest (n1=90, n2=10)', () => {
    const r = resampledTtest(D, 90, 10);
    expect(r.correction).toBeCloseTo(0.211111, 5);
    expect(r.t).toBeCloseTo(2.503867, 4);
    expect(r.df).toBe(9);
    expect(r.pValue).toBeCloseTo(0.03364766, 6);
    expect(r.significant).toBe(true); // p < 0.05
    expect(r.meanDiff).toBeCloseTo(0.025, 9);
  });

  it('kfoldTtest (k=5)', () => {
    const r = kfoldTtest(D, 5);
    expect(r.correction).toBeCloseTo(0.375, 6);
    expect(r.t).toBeCloseTo(1.878673, 4);
    expect(r.df).toBe(9);
    expect(r.pValue).toBeCloseTo(0.09300307, 6);
    expect(r.significant).toBe(false); // p > 0.05 — the correction matters!
  });

  it('repeatedKfoldTtest (k=5, r=2, n1=90, n2=10)', () => {
    const r = repeatedKfoldTtest(D, 5, 2, 90, 10);
    expect(r.correction).toBeCloseTo(0.211111, 5);
    expect(r.t).toBeCloseTo(2.503867, 4);
    expect(r.df).toBe(9); // k*r - 1
    expect(r.pValue).toBeCloseTo(0.03364766, 6);
  });

  it('repeatedKfoldTtest with k*r != n exercises df=k*r-1 independently (SciPy)', () => {
    // D length 10, k=3, r=3 → k*r=9 ≠ 10, so df=8 (not n-1=9) and correction uses 1/9.
    const r = repeatedKfoldTtest(D, 3, 3, 90, 10);
    expect(r.correction).toBeCloseTo(0.222222, 5); // 1/9 + 10/90
    expect(r.df).toBe(8); // k*r - 1, NOT n-1
    expect(r.t).toBeCloseTo(2.440468, 4);
    expect(r.pValue).toBeCloseTo(0.04053493, 6);
  });

  it('the correction is not a no-op: uncorrected t would be larger', () => {
    // Naïve paired t = mean/sqrt(s2/n): correction 1/n=0.1 << 0.211 → naïve t bigger.
    const r = resampledTtest(D, 90, 10);
    const naiveT = 0.025 / Math.sqrt(0.00047222 / 10);
    expect(naiveT).toBeGreaterThan(r.t); // corrected test is more conservative
  });
});

describe('edge cases', () => {
  it('needs ≥2 differences', () => {
    expect(() => resampledTtest([0.1], 10, 5)).toThrow();
  });
  it('rejects bad params (incl. NaN / non-integer, so no silent NaN p-value)', () => {
    expect(() => resampledTtest(D, 0, 10)).toThrow();
    expect(() => resampledTtest(D, NaN, 10)).toThrow();
    expect(() => kfoldTtest(D, 1)).toThrow();
    expect(() => kfoldTtest(D, 2.5)).toThrow();
    expect(() => repeatedKfoldTtest(D, 5, 0, 90, 10)).toThrow();
    expect(() => repeatedKfoldTtest(D, 5, 2, NaN, 10)).toThrow();
  });
  it('all-zero differences → t=0, p=1, not significant', () => {
    const r = resampledTtest([0, 0, 0, 0], 10, 5);
    expect(r.t).toBe(0);
    expect(r.pValue).toBe(1);
    expect(r.significant).toBe(false);
  });
});

describe('pairedDifferences', () => {
  it('aligns two models by key and drops unpaired/non-finite', () => {
    const a = new Map([['c1', 0.9], ['c2', 0.8], ['c3', 0.7]]);
    const b = new Map([['c1', 0.85], ['c2', 0.82], ['c4', 0.5]]);
    const { keys, diffs } = pairedDifferences(a, b);
    expect(keys).toEqual(['c1', 'c2']);
    expect(diffs[0]).toBeCloseTo(0.05, 9);
    expect(diffs[1]).toBeCloseTo(-0.02, 9);
  });
});
