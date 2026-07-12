/**
 * Pure geometry for classification plots (ROC, PR, calibration, confusion).
 *
 * These functions produce plain point arrays so a rendering layer can draw
 * them as SVG later. They are pure: no DOM, no network. Inputs mirror the
 * metrics module — `labels` are 0/1 and `scores` are probabilities in [0,1].
 */

import { auroc, auprc } from '../metrics/classification';

/** A 2-D point in plot coordinates. */
export interface Pt {
  x: number;
  y: number;
}

function checkPair(labels: number[], scores: number[]): void {
  if (labels.length !== scores.length) {
    throw new Error(`curves: length mismatch ${labels.length} vs ${scores.length}.`);
  }
  if (labels.length === 0) throw new Error('curves: empty input.');
}

/**
 * ROC curve as FPR (x) vs TPR (y) at every unique score threshold (descending),
 * plus the endpoints (0,0) and (1,1); `auc` comes from {@link auroc}.
 */
export function rocCurve(labels: number[], scores: number[]): { points: Pt[]; auc: number } {
  checkPair(labels, scores);
  const totalPos = labels.reduce((s, v) => s + (v === 1 ? 1 : 0), 0);
  const totalNeg = labels.length - totalPos;
  const thresholds = Array.from(new Set(scores)).sort((a, b) => b - a);
  const points: Pt[] = [{ x: 0, y: 0 }];
  for (const t of thresholds) {
    let tp = 0;
    let fp = 0;
    for (let i = 0; i < labels.length; i++) {
      if (scores[i]! >= t) {
        if (labels[i]! === 1) tp++;
        else fp++;
      }
    }
    const tpr = totalPos === 0 ? 0 : tp / totalPos;
    const fpr = totalNeg === 0 ? 0 : fp / totalNeg;
    points.push({ x: fpr, y: tpr });
  }
  points.push({ x: 1, y: 1 });
  return { points, auc: auroc(labels, scores) };
}

/**
 * Precision–recall curve as recall (x) vs precision (y) at every unique score
 * threshold (descending); `ap` (average precision) comes from {@link auprc}.
 */
export function prCurve(labels: number[], scores: number[]): { points: Pt[]; ap: number } {
  checkPair(labels, scores);
  const totalPos = labels.reduce((s, v) => s + (v === 1 ? 1 : 0), 0);
  const thresholds = Array.from(new Set(scores)).sort((a, b) => b - a);
  const points: Pt[] = [];
  for (const t of thresholds) {
    let tp = 0;
    let fp = 0;
    for (let i = 0; i < labels.length; i++) {
      if (scores[i]! >= t) {
        if (labels[i]! === 1) tp++;
        else fp++;
      }
    }
    const recall = totalPos === 0 ? 0 : tp / totalPos;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    points.push({ x: recall, y: precision });
  }
  return { points, ap: auprc(labels, scores) };
}

/**
 * Reliability (calibration) curve over `bins` equal-width probability bins:
 * x is the mean predicted probability in a bin, y the observed positive
 * fraction; empty bins are skipped. `perfect` is the diagonal reference.
 */
export function calibrationCurve(
  labels: number[],
  scores: number[],
  bins = 10
): { points: Pt[]; perfect: Pt[] } {
  checkPair(labels, scores);
  const count = new Array<number>(bins).fill(0);
  const sumScore = new Array<number>(bins).fill(0);
  const sumLabel = new Array<number>(bins).fill(0);
  for (let i = 0; i < labels.length; i++) {
    const s = scores[i]!;
    let b = Math.floor(s * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    count[b]!++;
    sumScore[b]! += s;
    sumLabel[b]! += labels[i]! === 1 ? 1 : 0;
  }
  const points: Pt[] = [];
  for (let b = 0; b < bins; b++) {
    const c = count[b]!;
    if (c === 0) continue;
    points.push({ x: sumScore[b]! / c, y: sumLabel[b]! / c });
  }
  return {
    points,
    perfect: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  };
}

/**
 * Confusion-matrix counts at a decision `threshold` (default 0.5): a case is
 * predicted positive when its score is >= the threshold.
 */
export function confusionCounts(
  labels: number[],
  scores: number[],
  threshold = 0.5
): { tp: number; fp: number; fn: number; tn: number } {
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
  return { tp, fp, fn, tn };
}
