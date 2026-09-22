/**
 * Multi-model comparison on the same cases (k models × N cases) and
 * between-dataset comparison — what a benchmarking platform reports when
 * more than two models or more than one data source are involved:
 *
 *  - Friedman χ² omnibus test (tie-corrected) + mean ranks (Demšar 2006)
 *  - Nemenyi critical difference for the mean-rank diagram
 *  - Pairwise Wilcoxon signed-rank with Holm step-down correction
 *  - Mann-Whitney U (unpaired) for dataset A vs dataset B of one model
 *
 * Pure, dependency-free; pinned against SciPy in tests/multi-model.test.ts.
 */

import { logGamma } from './corrected-tests';
import { normalTwoTailedP } from './normal';
import { wilcoxonSignedRank } from './paired-tests';

/** Regularized lower incomplete gamma P(a, x). */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const gln = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // continued fraction for Q, return 1 - Q
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Survival function of the χ² distribution. */
export function chi2Sf(x: number, df: number): number {
  return Math.max(0, Math.min(1, 1 - gammaP(df / 2, x / 2)));
}

/** Average ranks within one row (1 = smallest). */
function rankRow(row: readonly number[]): number[] {
  const idx = row.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(row.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) ranks[idx[t]![1]] = r;
    i = j + 1;
  }
  return ranks;
}

function validate(m: readonly (readonly number[])[]): number {
  if (m.length === 0) throw new Error('need at least one case');
  const k = m[0]!.length;
  for (const r of m) {
    if (r.length !== k) throw new Error('every case must have one score per model');
    if (r.some((v) => !Number.isFinite(v))) throw new Error('scores must be finite');
  }
  return k;
}

export interface FriedmanResult {
  statistic: number;
  df: number;
  pValue: number;
  /** Mean rank per model, 1 = best (highest score). */
  meanRanks: number[];
  n: number;
  k: number;
}

/** Friedman test on a cases × models matrix of "higher is better" scores. */
export function friedmanTest(matrix: readonly (readonly number[])[], higherIsBetter = true): FriedmanResult {
  const k = validate(matrix);
  const n = matrix.length;
  if (k < 2) throw new Error('need at least two models');
  const sums = new Array<number>(k).fill(0);
  let ties = 0;
  const bestSums = new Array<number>(k).fill(0);
  for (const row of matrix) {
    const r = rankRow(row);
    r.forEach((v, j) => (sums[j]! += v));
    const rb = rankRow(row.map((v) => (higherIsBetter ? -v : v)));
    rb.forEach((v, j) => (bestSums[j]! += v));
    const counts = new Map<number, number>();
    for (const v of row) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const t of counts.values()) ties += t ** 3 - t;
  }
  const ssbn = sums.reduce((s, v) => s + v * v, 0);
  let chi2 = (12 / (n * k * (k + 1))) * ssbn - 3 * n * (k + 1);
  const c = 1 - ties / (k * (k * k - 1) * n);
  chi2 = c > 0 ? chi2 / c : 0;
  return { statistic: chi2, df: k - 1, pValue: chi2Sf(chi2, k - 1), meanRanks: bestSums.map((s) => s / n), n, k };
}

/** Holm step-down adjusted p-values (same order as input). */
export function holmAdjust(p: readonly number[]): number[] {
  const m = p.length;
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(m);
  let running = 0;
  order.forEach(([v, i], r) => {
    running = Math.max(running, Math.min(1, (m - r) * v));
    out[i] = Math.round(running * 1e12) / 1e12;
  });
  return out;
}

export interface PairwiseResult {
  a: string;
  b: string;
  /** mean(a − b) */
  meanDiff: number;
  pRaw: number;
  pHolm: number;
  significant: boolean;
}

/** All-pairs Wilcoxon signed-rank on a cases × models matrix, Holm-corrected. */
export function pairwiseWilcoxonHolm(
  matrix: readonly (readonly number[])[],
  names: readonly string[],
  alpha = 0.05
): PairwiseResult[] {
  const k = validate(matrix);
  if (names.length !== k) throw new Error('one name per model column');
  const pairs: Omit<PairwiseResult, 'pHolm' | 'significant'>[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const d = matrix.map((r) => r[i]! - r[j]!);
      const nonZero = d.some((v) => v !== 0);
      pairs.push({
        a: names[i]!,
        b: names[j]!,
        meanDiff: d.reduce((s, v) => s + v, 0) / d.length,
        pRaw: nonZero ? wilcoxonSignedRank(d).pValue : 1,
      });
    }
  }
  const adj = holmAdjust(pairs.map((p) => p.pRaw));
  return pairs.map((p, i) => ({ ...p, pHolm: adj[i]!, significant: adj[i]! < alpha }));
}

export interface MannWhitneyResult {
  statistic: number;
  pValue: number;
  medianA: number;
  medianB: number;
  /** Rank-biserial effect size (−1..1), positive when A tends to be larger. */
  effectSize: number;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Two-sided Mann-Whitney U (normal approximation, tie + continuity correction). */
export function mannWhitneyU(a: readonly number[], b: readonly number[]): MannWhitneyResult {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) throw new Error('both samples need values');
  const ranks = rankRow([...a, ...b]);
  const r1 = ranks.slice(0, n1).reduce((s, v) => s + v, 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const counts = new Map<number, number>();
  for (const v of [...a, ...b]) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tie = 0;
  for (const t of counts.values()) tie += t ** 3 - t;
  const n = n1 + n2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1))));
  const u = Math.max(u1, n1 * n2 - u1);
  const z = sigma === 0 ? 0 : Math.max(0, u - mu - 0.5) / sigma;
  return {
    statistic: u1,
    pValue: sigma === 0 ? 1 : Math.min(1, normalTwoTailedP(z)),
    medianA: median(a),
    medianB: median(b),
    effectSize: (2 * u1) / (n1 * n2) - 1,
  };
}

// Studentized range / √2, α = 0.05 (Demšar 2006, Table 5a), k = 2..10.
const Q05 = [0, 0, 1.96, 2.343, 2.569, 2.728, 2.85, 2.949, 3.031, 3.102, 3.164];

/** Nemenyi critical difference of mean ranks at α = 0.05. */
export function nemenyiCriticalDifference(k: number, n: number): number {
  const q = Q05[k];
  if (!q) throw new Error('Nemenyi CD table covers k = 2..10 models');
  return q * Math.sqrt((k * (k + 1)) / (6 * n));
}
