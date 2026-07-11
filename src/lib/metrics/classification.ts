/**
 * Binary-classification evaluation metrics for radiology benchmarking.
 *
 * The engine is task-agnostic (segmentation is wired to the UI first) but the
 * classification metrics are ready so a CXR-classification benchmark is a thin
 * follow-up. All functions are pure.
 *
 * Inputs:
 *  - `labels`: ground-truth 0/1 per case.
 *  - `scores`: model probability in [0,1] per case (same length).
 *  - Threshold metrics use a decision threshold (default 0.5).
 */

export interface ThresholdMetrics {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  accuracy: number;
  sensitivity: number; // recall / TPR
  specificity: number; // TNR
  ppv: number; // precision
  npv: number;
  f1: number;
}

function checkPair(labels: readonly number[], scores: readonly number[]): void {
  if (labels.length !== scores.length) {
    throw new Error(`classification: length mismatch ${labels.length} vs ${scores.length}.`);
  }
  if (labels.length === 0) throw new Error('classification: empty input.');
}

/** Confusion-derived metrics at a fixed decision threshold. */
export function thresholdMetrics(
  labels: readonly number[],
  scores: readonly number[],
  threshold = 0.5
): ThresholdMetrics {
  checkPair(labels, scores);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < labels.length; i++) {
    const positive = scores[i]! >= threshold;
    const actual = labels[i]! === 1;
    if (positive && actual) tp++;
    else if (positive && !actual) fp++;
    else if (!positive && actual) fn++;
    else tn++;
  }
  const total = tp + fp + fn + tn;
  const accuracy = (tp + tn) / total;
  const sensitivity = tp + fn === 0 ? NaN : tp / (tp + fn);
  const specificity = tn + fp === 0 ? NaN : tn / (tn + fp);
  const ppv = tp + fp === 0 ? NaN : tp / (tp + fp);
  const npv = tn + fn === 0 ? NaN : tn / (tn + fn);
  const f1 =
    Number.isNaN(ppv) || Number.isNaN(sensitivity) || ppv + sensitivity === 0
      ? NaN
      : (2 * ppv * sensitivity) / (ppv + sensitivity);
  return { threshold, tp, fp, fn, tn, accuracy, sensitivity, specificity, ppv, npv, f1 };
}

/**
 * Area under the ROC curve via the rank-sum (Mann–Whitney U) statistic, which
 * handles tied scores correctly by averaging ranks. Returns NaN when one class
 * is absent (AUROC undefined).
 */
export function auroc(labels: readonly number[], scores: readonly number[]): number {
  checkPair(labels, scores);
  const n = labels.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  // Assign fractional (average) ranks 1..n to handle ties.
  const ranks = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]!]! === scores[idx[i]!]!) j++;
    const avgRank = (i + 1 + (j + 1)) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[idx[k]!] = avgRank;
    i = j + 1;
  }
  let nPos = 0;
  let sumRankPos = 0;
  for (let k = 0; k < n; k++) {
    if (labels[k]! === 1) {
      nPos++;
      sumRankPos += ranks[k]!;
    }
  }
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) return NaN;
  const u = sumRankPos - (nPos * (nPos + 1)) / 2;
  return u / (nPos * nNeg);
}

/**
 * Area under the precision–recall curve (average precision), computed as the
 * sum of precision·Δrecall over score thresholds. NaN when there are no positives.
 */
export function auprc(labels: readonly number[], scores: readonly number[]): number {
  checkPair(labels, scores);
  const n = labels.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b]! - scores[a]!);
  const totalPos = labels.reduce((s, v) => s + (v === 1 ? 1 : 0), 0);
  if (totalPos === 0) return NaN;
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let ap = 0;
  let k = 0;
  while (k < n) {
    // Consume all entries with equal score together (correct handling of ties).
    const s = scores[order[k]!]!;
    while (k < n && scores[order[k]!]! === s) {
      if (labels[order[k]!]! === 1) tp++;
      else fp++;
      k++;
    }
    const recall = tp / totalPos;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    ap += precision * (recall - prevRecall);
    prevRecall = recall;
  }
  return ap;
}

/** Mean squared error between probability and outcome. */
export function brierScore(labels: readonly number[], scores: readonly number[]): number {
  checkPair(labels, scores);
  let sum = 0;
  for (let i = 0; i < labels.length; i++) {
    const d = scores[i]! - labels[i]!;
    sum += d * d;
  }
  return sum / labels.length;
}

/**
 * Expected Calibration Error over `bins` equal-width probability bins:
 * Σ (|bin| / N) · |accuracy(bin) − confidence(bin)|.
 */
export function expectedCalibrationError(
  labels: readonly number[],
  scores: readonly number[],
  bins = 10
): number {
  checkPair(labels, scores);
  const n = labels.length;
  const binCount = new Array<number>(bins).fill(0);
  const binConf = new Array<number>(bins).fill(0);
  const binAcc = new Array<number>(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const s = scores[i]!;
    let b = Math.floor(s * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    binCount[b]!++;
    binConf[b]! += s;
    binAcc[b]! += labels[i]! === 1 ? 1 : 0;
  }
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const c = binCount[b]!;
    if (c === 0) continue;
    const conf = binConf[b]! / c;
    const acc = binAcc[b]! / c;
    ece += (c / n) * Math.abs(acc - conf);
  }
  return ece;
}

export interface ClassificationMetrics extends ThresholdMetrics {
  auroc: number;
  auprc: number;
  brier: number;
  ece: number;
  n: number;
  positives: number;
}

/** Full classification metric set at a decision threshold (default 0.5). */
export function classificationMetrics(
  labels: readonly number[],
  scores: readonly number[],
  threshold = 0.5,
  eceBins = 10
): ClassificationMetrics {
  const t = thresholdMetrics(labels, scores, threshold);
  return {
    ...t,
    auroc: auroc(labels, scores),
    auprc: auprc(labels, scores),
    brier: brierScore(labels, scores),
    ece: expectedCalibrationError(labels, scores, eceBins),
    n: labels.length,
    positives: labels.reduce((s, v) => s + (v === 1 ? 1 : 0), 0),
  };
}
