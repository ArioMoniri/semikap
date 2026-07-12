/**
 * Additional paired model-comparison tests (complement the corrected t-tests):
 *  - McNemar's test        — paired binary correct/incorrect on the same cases.
 *  - Wilcoxon signed-rank  — non-parametric paired test (normal approximation).
 *  - Permutation (sign-flip) test — exact for small n, seeded Monte-Carlo otherwise.
 *  - Bootstrap CI          — percentile CI + p-value for a mean paired difference.
 *
 * Pure + deterministic (permutation/bootstrap take a fixed seed). No dependencies.
 */

import { normalTwoTailedP } from './normal';
import { logGamma } from './corrected-tests';

// --- seeded PRNG (mulberry32) for reproducible resampling ---------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- McNemar --------------------------------------------------------------

export interface McNemarResult {
  b: number; // A correct, B wrong
  c: number; // A wrong, B correct
  chi2: number; // with continuity correction
  pValueChi2: number;
  pValueExact: number;
  /** Recommended p (exact when b+c < 25, else chi²). */
  pValue: number;
  significant: boolean;
  alpha: number;
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Two-sided exact binomial p for k successes of `n` at p=0.5 (McNemar exact). */
function binomTwoSidedHalf(k: number, n: number): number {
  if (n === 0) return 1;
  let tail = 0;
  const kk = Math.min(k, n - k);
  for (let i = 0; i <= kk; i++) tail += Math.exp(logChoose(n, i) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

/** McNemar's test on two binary correctness vectors (1 = correct). */
export function mcNemarTest(correctA: readonly number[], correctB: readonly number[], alpha = 0.05): McNemarResult {
  if (correctA.length !== correctB.length) throw new Error('mcNemarTest: vectors must be equal length.');
  if (correctA.length === 0) throw new Error('mcNemarTest: empty input.');
  let b = 0;
  let c = 0;
  for (let i = 0; i < correctA.length; i++) {
    const a = correctA[i] ? 1 : 0;
    const bb = correctB[i] ? 1 : 0;
    if (a === 1 && bb === 0) b++;
    else if (a === 0 && bb === 1) c++;
  }
  const nDisc = b + c;
  const chi2 = nDisc === 0 ? 0 : (Math.abs(b - c) - 1) ** 2 / nDisc;
  const pValueChi2 = nDisc === 0 ? 1 : normalTwoTailedP(Math.sqrt(chi2));
  const pValueExact = binomTwoSidedHalf(Math.min(b, c), nDisc);
  const pValue = nDisc < 25 ? pValueExact : pValueChi2;
  return { b, c, chi2, pValueChi2, pValueExact, pValue, significant: pValue < alpha, alpha };
}

// --- Wilcoxon signed-rank (normal approximation, tie + continuity corr.) --

export interface WilcoxonResult {
  statistic: number; // min(W+, W-)
  z: number;
  pValue: number;
  n: number; // non-zero differences
  significant: boolean;
  alpha: number;
}

function midranks(x: readonly number[]): number[] {
  const n = x.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a]! - x[b]!);
  const t = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && x[order[j]!]! === x[order[i]!]!) j++;
    const rank = 0.5 * (i + j - 1) + 1;
    for (let m = i; m < j; m++) t[order[m]!] = rank;
    i = j;
  }
  return t;
}

/** Wilcoxon signed-rank test on paired differences (zeros dropped). */
export function wilcoxonSignedRank(d: readonly number[], alpha = 0.05): WilcoxonResult {
  const nz = d.filter((v) => v !== 0);
  const n = nz.length;
  if (n < 1) throw new Error('wilcoxonSignedRank: need at least one non-zero difference.');
  const abs = nz.map((v) => Math.abs(v));
  const ranks = midranks(abs);
  let rPlus = 0;
  let rMinus = 0;
  for (let i = 0; i < n; i++) {
    if (nz[i]! > 0) rPlus += ranks[i]!;
    else rMinus += ranks[i]!;
  }
  const T = Math.min(rPlus, rMinus);
  const mn = (n * (n + 1)) / 4;
  // tie correction on the |d| ranks
  const counts = new Map<number, number>();
  for (const a of abs) counts.set(a, (counts.get(a) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of counts.values()) tieTerm += t ** 3 - t;
  const se = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48);
  const corr = 0.5 * Math.sign(T - mn);
  const z = se === 0 ? 0 : (T - mn - corr) / se;
  const pValue = se === 0 ? 1 : normalTwoTailedP(z);
  return { statistic: T, z, pValue, n, significant: pValue < alpha, alpha };
}

// --- Permutation (sign-flip) test ----------------------------------------

export interface PermutationResult {
  meanDiff: number;
  pValue: number;
  method: 'exact' | 'monte-carlo';
  iterations: number;
  significant: boolean;
  alpha: number;
}

/** Two-sided sign-flip permutation test for a mean paired difference. */
export function permutationTest(
  d: readonly number[],
  alpha = 0.05,
  opts: { maxExactN?: number; mcSamples?: number; seed?: number } = {}
): PermutationResult {
  const n = d.length;
  if (n < 1) throw new Error('permutationTest: empty input.');
  const maxExactN = opts.maxExactN ?? 18;
  const observed = Math.abs(d.reduce((s, v) => s + v, 0)) / n;
  const absMeanFrom = (signs: (i: number) => number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += signs(i) * d[i]!;
    return Math.abs(s) / n;
  };

  if (n <= maxExactN) {
    const total = 2 ** n;
    let ge = 0;
    for (let mask = 0; mask < total; mask++) {
      const val = absMeanFrom((i) => ((mask >> i) & 1 ? -1 : 1));
      if (val >= observed - 1e-12) ge++;
    }
    return { meanDiff: d.reduce((s, v) => s + v, 0) / n, pValue: ge / total, method: 'exact', iterations: total, significant: ge / total < alpha, alpha };
  }

  const samples = opts.mcSamples ?? 10000;
  const rng = mulberry32(opts.seed ?? 12345);
  let ge = 1; // include observed (add-one correction)
  for (let s = 0; s < samples; s++) {
    const val = absMeanFrom(() => (rng() < 0.5 ? -1 : 1));
    if (val >= observed - 1e-12) ge++;
  }
  const p = ge / (samples + 1);
  return { meanDiff: d.reduce((s, v) => s + v, 0) / n, pValue: p, method: 'monte-carlo', iterations: samples, significant: p < alpha, alpha };
}

// --- Bootstrap CI for a mean paired difference ---------------------------

export interface BootstrapResult {
  meanDiff: number;
  ciLow: number;
  ciHigh: number;
  /** Bootstrap two-sided p ≈ 2·min(frac ≤ 0, frac ≥ 0). */
  pValue: number;
  iterations: number;
  significant: boolean;
  alpha: number;
}

/** Percentile bootstrap CI + p-value for the mean of paired differences. */
export function bootstrapDiffCI(
  d: readonly number[],
  alpha = 0.05,
  opts: { samples?: number; seed?: number } = {}
): BootstrapResult {
  const n = d.length;
  if (n < 2) throw new Error('bootstrapDiffCI: need at least 2 differences.');
  const samples = opts.samples ?? 2000;
  const rng = mulberry32(opts.seed ?? 12345);
  const means = new Array<number>(samples);
  let leq = 0;
  let geq = 0;
  for (let s = 0; s < samples; s++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[(rng() * n) | 0]!;
    const m = sum / n;
    means[s] = m;
    if (m <= 0) leq++;
    if (m >= 0) geq++;
  }
  means.sort((a, b) => a - b);
  const q = (p: number): number => {
    const idx = Math.min(samples - 1, Math.max(0, Math.round(p * (samples - 1))));
    return means[idx]!;
  };
  const observed = d.reduce((s, v) => s + v, 0) / n;
  const pValue = Math.min(1, 2 * Math.min(leq / samples, geq / samples));
  return {
    meanDiff: observed,
    ciLow: q(alpha / 2),
    ciHigh: q(1 - alpha / 2),
    pValue,
    iterations: samples,
    significant: pValue < alpha,
    alpha,
  };
}
