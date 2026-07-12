/**
 * Corrected statistical tests for comparing two models on resampled data,
 * adapting the `correctR` R package (Nadeau & Bengio 2003 variance correction).
 * See docs/benchmark/STATS.md for the formulas + references.
 *
 * Pure, dependency-free — including a from-scratch Student-t p-value via the
 * regularized incomplete beta function (no stats library).
 */

// --- Special functions ---------------------------------------------------

/** log Γ(x) via the Lanczos approximation (valid for x > 0 and via reflection). */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula Γ(x)Γ(1−x) = π / sin(πx).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const y = x - 1;
  let a = c[0]!;
  const t = y + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued-fraction expansion for the incomplete beta (Numerical Recipes betacf). */
function betacf(x: number, a: number, b: number): number {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) ∈ [0,1]. */
export function ibeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

/** Student-t CDF P(T ≤ t) for `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  const x = df / (df + t * t);
  const ib = ibeta(x, df / 2, 0.5);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/** Two-tailed Student-t p-value = 2·P(T ≤ −|t|) = I_{df/(df+t²)}(df/2, 1/2). */
export function studentTTwoTailedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  const x = df / (df + t * t);
  return ibeta(x, df / 2, 0.5);
}

// --- Corrected tests -----------------------------------------------------

export type TestKind = 'resampled' | 'kfold' | 'repeated-kfold';

export interface CorrectedTestResult {
  kind: TestKind;
  t: number;
  df: number;
  pValue: number;
  meanDiff: number;
  /** Number of paired differences used. */
  n: number;
  /** Variance-correction multiplier applied to var(d). */
  correction: number;
  /** True when pValue < alpha (default 0.05). */
  significant: boolean;
  alpha: number;
}

function mean(d: readonly number[]): number {
  return d.reduce((a, b) => a + b, 0) / d.length;
}

/** Unbiased (n−1) sample variance. */
function sampleVariance(d: readonly number[]): number {
  const n = d.length;
  const m = mean(d);
  return d.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1);
}

function assertUsable(d: readonly number[]): void {
  if (d.length < 2) throw new Error('Corrected t-test needs at least 2 paired differences.');
  if (!d.every((v) => Number.isFinite(v))) throw new Error('Differences must all be finite.');
}

function finish(
  kind: TestKind,
  d: readonly number[],
  df: number,
  correction: number,
  alpha: number
): CorrectedTestResult {
  const mu = mean(d);
  const s2 = sampleVariance(d);
  const denom = Math.sqrt(s2 * correction);
  // All-zero differences (or zero variance with zero mean) → no effect, p = 1.
  const t = denom === 0 ? (mu === 0 ? 0 : Infinity * Math.sign(mu)) : mu / denom;
  const pValue = denom === 0 ? (mu === 0 ? 1 : 0) : studentTTwoTailedP(t, df);
  return { kind, t, df, pValue, meanDiff: mu, n: d.length, correction, significant: pValue < alpha, alpha };
}

/**
 * Corrected resampled t-test (repeated random train/test splits).
 * @param d per-resample differences (A − B). @param n1 train size. @param n2 test size.
 */
export function resampledTtest(d: readonly number[], n1: number, n2: number, alpha = 0.05): CorrectedTestResult {
  assertUsable(d);
  if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 <= 0 || n2 < 0) {
    throw new Error('n1 must be a finite number > 0 and n2 a finite number ≥ 0.');
  }
  const n = d.length;
  const correction = 1 / n + n2 / n1;
  return finish('resampled', d, n - 1, correction, alpha);
}

/**
 * Corrected k-fold cross-validation t-test.
 * @param d per-fold differences (A − B). @param k number of folds.
 */
export function kfoldTtest(d: readonly number[], k: number, alpha = 0.05): CorrectedTestResult {
  assertUsable(d);
  if (!Number.isInteger(k) || k < 2) throw new Error('k must be an integer ≥ 2.');
  const n = d.length;
  const correction = (1 / n + 1 / k) / (1 - 1 / k);
  return finish('kfold', d, n - 1, correction, alpha);
}

/**
 * Corrected repeated k-fold cross-validation t-test.
 * @param d per-(fold,repeat) differences (A − B). @param k folds. @param r repeats.
 */
export function repeatedKfoldTtest(
  d: readonly number[],
  k: number,
  r: number,
  n1: number,
  n2: number,
  alpha = 0.05
): CorrectedTestResult {
  assertUsable(d);
  if (!Number.isInteger(k) || k < 2 || !Number.isInteger(r) || r < 1) {
    throw new Error('k must be an integer ≥ 2 and r an integer ≥ 1.');
  }
  if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 <= 0 || n2 < 0) {
    throw new Error('n1 must be a finite number > 0 and n2 a finite number ≥ 0.');
  }
  const correction = 1 / (k * r) + n2 / n1;
  return finish('repeated-kfold', d, k * r - 1, correction, alpha);
}

/** Pair two models' per-key metric values into an aligned difference vector (A − B). */
export function pairedDifferences(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>
): { keys: string[]; diffs: number[] } {
  const keys: string[] = [];
  const diffs: number[] = [];
  for (const [key, va] of a) {
    const vb = b.get(key);
    if (vb === undefined || !Number.isFinite(va) || !Number.isFinite(vb)) continue;
    keys.push(key);
    diffs.push(va - vb);
  }
  return { keys, diffs };
}
