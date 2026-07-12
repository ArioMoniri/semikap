import { describe, expect, it } from 'vitest';
import { erf, normalCdf, normalTwoTailedP } from '../src/lib/stats/normal';
import { deLongTest } from '../src/lib/stats/roc-compare';
import {
  mcNemarTest,
  wilcoxonSignedRank,
  permutationTest,
  bootstrapDiffCI,
} from '../src/lib/stats/paired-tests';
import { bayesianCorrelatedTtest, rhoFromSizes } from '../src/lib/stats/bayesian';

describe('normal helpers', () => {
  it('erf / normalCdf known values', () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalTwoTailedP(1.959964)).toBeCloseTo(0.05, 4);
    expect(normalTwoTailedP(0)).toBeCloseTo(1, 6);
  });
});

// DeLong reference computed with the Sun & Xu fast algorithm (validated vs the
// standard Python implementation): auc1=1.0, auc2=0.82, z=1.248075, p=0.212003.
describe('DeLong AUROC comparison', () => {
  const labels = [1, 1, 1, 1, 0, 0, 0, 0, 1, 0];
  const A = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.2, 0.85, 0.3];
  const B = [0.6, 0.55, 0.8, 0.4, 0.5, 0.45, 0.3, 0.35, 0.7, 0.6];

  it('matches the reference AUCs, z and p', () => {
    const r = deLongTest(labels, A, B);
    expect(r.auc1).toBeCloseTo(1.0, 6);
    expect(r.auc2).toBeCloseTo(0.82, 6);
    expect(r.z).toBeCloseTo(1.248075, 3);
    expect(r.pValue).toBeCloseTo(0.212003, 4);
    expect(r.significant).toBe(false);
  });
  it('identical models → z 0, p 1', () => {
    const r = deLongTest(labels, A, A);
    expect(r.aucDiff).toBeCloseTo(0, 9);
    expect(r.pValue).toBe(1);
  });
  it('needs both classes', () => {
    expect(() => deLongTest([1, 1, 1], A.slice(0, 3), B.slice(0, 3))).toThrow();
  });
});

describe('McNemar', () => {
  // 8 cases A-correct/B-wrong, 3 cases A-wrong/B-correct.
  const A = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0];
  const B = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1];
  it('matches chi2 (continuity) and exact binomial references', () => {
    const r = mcNemarTest(A, B);
    expect(r.b).toBe(8);
    expect(r.c).toBe(3);
    expect(r.chi2).toBeCloseTo(1.454545, 5);
    expect(r.pValueChi2).toBeCloseTo(0.2278, 4);
    expect(r.pValueExact).toBeCloseTo(0.226562, 6);
    expect(r.pValue).toBeCloseTo(0.226562, 6); // b+c<25 → exact
  });
});

describe('Wilcoxon signed-rank', () => {
  const d = [0.05, 0.02, 0.03, -0.01, 0.04, 0.02, 0.06, 0.03, 0.01, -0.02];
  it('matches SciPy (approx, continuity)', () => {
    const r = wilcoxonSignedRank(d);
    expect(r.statistic).toBeCloseTo(5.5, 6);
    expect(r.pValue).toBeCloseTo(0.027802, 4);
    expect(r.significant).toBe(true);
  });
});

describe('permutation (sign-flip) test', () => {
  it('exact small-n p-value is hand-computable', () => {
    // d=[1,1,1,1]: only all-+ and all-- reach |mean|=1 → p = 2/16 = 0.125.
    const r = permutationTest([1, 1, 1, 1]);
    expect(r.method).toBe('exact');
    expect(r.pValue).toBeCloseTo(0.125, 9);
  });
  it('monte-carlo path is deterministic under a fixed seed', () => {
    const d = Array.from({ length: 25 }, (_, i) => (i % 2 ? 0.02 : 0.03));
    const a = permutationTest(d, 0.05, { seed: 7, mcSamples: 2000 });
    const b = permutationTest(d, 0.05, { seed: 7, mcSamples: 2000 });
    expect(a.method).toBe('monte-carlo');
    expect(a.pValue).toBe(b.pValue);
  });
});

describe('bootstrap CI', () => {
  it('a strongly positive difference is significant with CI excluding 0', () => {
    const d = [0.1, 0.12, 0.09, 0.11, 0.1, 0.13, 0.08, 0.1];
    const r = bootstrapDiffCI(d, 0.05, { seed: 1, samples: 3000 });
    expect(r.ciLow).toBeGreaterThan(0);
    expect(r.significant).toBe(true);
  });
  it('is deterministic under a fixed seed', () => {
    const d = [0.05, -0.02, 0.03, 0.01, -0.04, 0.02];
    const a = bootstrapDiffCI(d, 0.05, { seed: 42, samples: 1000 });
    const b = bootstrapDiffCI(d, 0.05, { seed: 42, samples: 1000 });
    expect(a.ciLow).toBe(b.ciLow);
    expect(a.ciHigh).toBe(b.ciHigh);
  });
});

describe('Bayesian correlated t-test (Benavoli 2017)', () => {
  const d = [0.05, 0.02, 0.03, -0.01, 0.04, 0.02, 0.06, 0.0, 0.03, 0.01];
  it('matches the reference posterior probabilities', () => {
    const r = bayesianCorrelatedTtest(d, rhoFromSizes(90, 10), 0.01);
    expect(r.rho).toBeCloseTo(0.1, 9);
    expect(r.pLeft).toBeCloseTo(0.003333, 5);
    expect(r.pRope).toBeCloseTo(0.080298, 5);
    expect(r.pRight).toBeCloseTo(0.916369, 5);
    expect(r.pLeft + r.pRope + r.pRight).toBeCloseTo(1, 9);
  });
  it('rejects invalid rho/rope', () => {
    expect(() => bayesianCorrelatedTtest(d, 1.5, 0.01)).toThrow();
    expect(() => bayesianCorrelatedTtest(d, 0.1, -1)).toThrow();
  });
});
