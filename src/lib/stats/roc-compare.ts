/**
 * DeLong's test for comparing two correlated ROC AUCs on the same cases
 * (DeLong, DeLong & Clarke-Pearson 1988; fast algorithm Sun & Xu 2014). This is
 * the recommended method in medical imaging for testing whether two models'
 * AUROCs differ, because it accounts for the correlation from evaluating both
 * models on the same subjects. Pure, no dependencies.
 */

import { normalTwoTailedP } from './normal';

export interface DeLongResult {
  auc1: number;
  auc2: number;
  aucDiff: number;
  /** Estimated variance of (auc1 − auc2). */
  variance: number;
  z: number;
  pValue: number;
  significant: boolean;
  alpha: number;
  nPos: number;
  nNeg: number;
}

/** Average (mid) ranks, 1-based, tie-corrected. */
function midranks(x: readonly number[]): number[] {
  const n = x.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a]! - x[b]!);
  const t = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && x[order[j]!]! === x[order[i]!]!) j++;
    const rank = 0.5 * (i + j - 1) + 1; // average of 1-based ranks i+1..j
    for (let m = i; m < j; m++) t[order[m]!] = rank;
    i = j;
  }
  return t;
}

function mean(a: readonly number[]): number {
  return a.reduce((s, v) => s + v, 0) / a.length;
}

/** Unbiased covariance of two equal-length vectors (n−1 denominator). */
function cov(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i]! - ma) * (b[i]! - mb);
  return s / (n - 1);
}

/**
 * DeLong test comparing AUC(scores1) vs AUC(scores2) against binary `labels`
 * (1 = positive, 0 = negative), all aligned per case.
 */
export function deLongTest(
  labels: readonly number[],
  scores1: readonly number[],
  scores2: readonly number[],
  alpha = 0.05
): DeLongResult {
  const n = labels.length;
  if (n !== scores1.length || n !== scores2.length) {
    throw new Error('deLongTest: labels and both score vectors must be the same length.');
  }
  const posIdx: number[] = [];
  const negIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (labels[i] === 1) posIdx.push(i);
    else if (labels[i] === 0) negIdx.push(i);
    else throw new Error('deLongTest: labels must be 0 or 1.');
  }
  const m = posIdx.length;
  const nn = negIdx.length;
  if (m === 0 || nn === 0) throw new Error('deLongTest: need at least one positive and one negative case.');

  const models = [scores1, scores2];
  const aucs: number[] = [];
  const v01: number[][] = []; // structural components over positives, per model
  const v10: number[][] = []; // over negatives, per model
  for (const s of models) {
    const posScores = posIdx.map((i) => s[i]!);
    const negScores = negIdx.map((i) => s[i]!);
    const all = [...posScores, ...negScores];
    const tx = midranks(posScores);
    const ty = midranks(negScores);
    const tz = midranks(all);
    let sumPos = 0;
    for (let i = 0; i < m; i++) sumPos += tz[i]!;
    const auc = (sumPos / m - (m + 1) / 2) / nn;
    aucs.push(auc);
    const c01 = new Array<number>(m);
    for (let i = 0; i < m; i++) c01[i] = (tz[i]! - tx[i]!) / nn;
    const c10 = new Array<number>(nn);
    for (let j = 0; j < nn; j++) c10[j] = 1 - (tz[m + j]! - ty[j]!) / m;
    v01.push(c01);
    v10.push(c10);
  }

  // 2×2 covariance S = Sx/m + Sy/n over structural components.
  const sx00 = cov(v01[0]!, v01[0]!);
  const sx01 = cov(v01[0]!, v01[1]!);
  const sx11 = cov(v01[1]!, v01[1]!);
  const sy00 = cov(v10[0]!, v10[0]!);
  const sy01 = cov(v10[0]!, v10[1]!);
  const sy11 = cov(v10[1]!, v10[1]!);
  const s00 = sx00 / m + sy00 / nn;
  const s01 = sx01 / m + sy01 / nn;
  const s11 = sx11 / m + sy11 / nn;
  const variance = s00 + s11 - 2 * s01;

  const aucDiff = aucs[0]! - aucs[1]!;
  const z = variance > 0 ? aucDiff / Math.sqrt(variance) : aucDiff === 0 ? 0 : Infinity * Math.sign(aucDiff);
  const pValue = variance > 0 ? normalTwoTailedP(z) : aucDiff === 0 ? 1 : 0;
  return {
    auc1: aucs[0]!,
    auc2: aucs[1]!,
    aucDiff,
    variance,
    z,
    pValue,
    significant: pValue < alpha,
    alpha,
    nPos: m,
    nNeg: nn,
  };
}
