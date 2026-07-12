/**
 * Detection evaluation metrics for radiology benchmarking (doc §5).
 *
 * All functions are pure. Boxes are axis-aligned `Box` records (see
 * `../datasets/boxes`): 2-D by default (`x,y,w,h`) with optional 3-D depth
 * (`z,d`) and a detection `score` in [0,1]. Predictions and references must be
 * expressed in the same coordinate frame; the engine is unit-free.
 *
 * The matcher is greedy and score-ordered per image: each prediction (highest
 * score first) claims the still-unmatched reference with the largest IoU that
 * clears `iouThreshold`, becoming a true positive; unclaimed predictions are
 * false positives and unclaimed references are false negatives — the standard
 * lesion-level protocol used for FROC and VOC-style mean AP.
 */

import type { Box } from '../datasets/boxes';

/** Aggregate detection metrics over a cohort of images. */
export interface DetectionResult {
  /** Matched predictions (true positives). */
  tp: number;
  /** Unmatched predictions (false positives). */
  fp: number;
  /** Unmatched references (false negatives / missed lesions). */
  fn: number;
  /** TP / (TP + FN); 0 when there are no reference boxes. */
  lesionSensitivity: number;
  /** FP divided by the number of images. */
  fpPerImage: number;
  /** Average-precision at `iouThreshold` (all-points/VOC); 0 with no references. */
  meanAp: number;
  /** Mean center-to-center distance over matched pairs; 0 when there are no TPs. */
  localizationErrorMean: number;
  /** FROC operating points, ascending in `fpPerImage`. */
  froc: { scoreThreshold: number; sensitivity: number; fpPerImage: number }[];
}

/** Confidence used for ordering/thresholding; ground-truth-less boxes count as 1. */
function scoreOf(b: Box): number {
  return b.score ?? 1;
}

/** True when both boxes carry the z-extent required for a 3-D IoU. */
function is3D(a: Box, b: Box): boolean {
  return a.z !== undefined && a.d !== undefined && b.z !== undefined && b.d !== undefined;
}

/** Length of the overlap of [a0,a0+ae] and [b0,b0+be]; 0 if disjoint. */
function overlap1D(a0: number, ae: number, b0: number, be: number): number {
  return Math.max(0, Math.min(a0 + ae, b0 + be) - Math.max(a0, b0));
}

/**
 * Intersection-over-union of two boxes; 2-D by area, 3-D by volume when both
 * boxes carry `z` and `d`. Returns 0 when there is no overlap. Pure.
 */
export function iouBox(a: Box, b: Box): number {
  const ox = overlap1D(a.x, a.w, b.x, b.w);
  const oy = overlap1D(a.y, a.h, b.y, b.h);
  if (is3D(a, b)) {
    const oz = overlap1D(a.z!, a.d!, b.z!, b.d!);
    const inter = ox * oy * oz;
    if (inter <= 0) return 0;
    const volA = a.w * a.h * a.d!;
    const volB = b.w * b.h * b.d!;
    const union = volA + volB - inter;
    return union > 0 ? inter / union : 0;
  }
  const inter = ox * oy;
  if (inter <= 0) return 0;
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/** Euclidean center distance; 3-D when both boxes carry z & d, else 2-D. */
function centerDistance(a: Box, b: Box): number {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  if (is3D(a, b)) {
    const dz = a.z! + a.d! / 2 - (b.z! + b.d! / 2);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(dx * dx + dy * dy);
}

/** Per-prediction match outcome, in the original prediction order of a case. */
interface MatchOutcome {
  score: number;
  isTp: boolean;
  /** Center distance to the matched reference; 0 for false positives. */
  locErr: number;
}

/** Greedy score-ordered matching within a single image. */
function matchCase(
  preds: Box[],
  refs: Box[],
  iouThreshold: number
): { outcomes: MatchOutcome[]; fn: number } {
  const order = preds
    .map((b, i) => ({ b, i }))
    .sort((p, q) => scoreOf(q.b) - scoreOf(p.b));
  const refUsed = new Array<boolean>(refs.length).fill(false);
  const outcomes: MatchOutcome[] = [];
  for (const { b } of order) {
    let bestIdx = -1;
    let bestIou = -Infinity;
    for (let j = 0; j < refs.length; j++) {
      if (refUsed[j]) continue;
      const iou = iouBox(b, refs[j]!);
      if (iou >= iouThreshold && iou > bestIou) {
        bestIou = iou;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      refUsed[bestIdx] = true;
      outcomes.push({ score: scoreOf(b), isTp: true, locErr: centerDistance(b, refs[bestIdx]!) });
    } else {
      outcomes.push({ score: scoreOf(b), isTp: false, locErr: 0 });
    }
  }
  const fn = refUsed.reduce((acc, used) => acc + (used ? 0 : 1), 0);
  return { outcomes, fn };
}

/** VOC all-points average precision from score-desc TP/FP outcomes. */
function averagePrecision(outcomes: MatchOutcome[], totalRefs: number): number {
  if (totalRefs === 0) return 0;
  const sorted = [...outcomes].sort((a, b) => b.score - a.score);
  const rec: number[] = [];
  const pre: number[] = [];
  let cumTp = 0;
  let cumFp = 0;
  for (const o of sorted) {
    if (o.isTp) cumTp++;
    else cumFp++;
    rec.push(cumTp / totalRefs);
    pre.push(cumTp / (cumTp + cumFp));
  }
  // Envelope: prepend (0,0) and append (1,0); make precision monotone-decreasing.
  const mrec = [0, ...rec, 1];
  const mpre = [0, ...pre, 0];
  for (let i = mpre.length - 1; i > 0; i--) {
    mpre[i - 1] = Math.max(mpre[i - 1]!, mpre[i]!);
  }
  let ap = 0;
  for (let i = 0; i + 1 < mrec.length; i++) {
    if (mrec[i + 1]! !== mrec[i]!) {
      ap += (mrec[i + 1]! - mrec[i]!) * mpre[i + 1]!;
    }
  }
  return ap;
}

/**
 * Detection metrics over a cohort: TP/FP/FN, lesion sensitivity, FP-per-image,
 * mean AP, mean localization error, and the FROC curve, matching at
 * `iouThreshold` (default 0.3). `caseIds` enumerates every image (its length is
 * the FP-per-image and FROC denominator); boxes are grouped by their `caseId`.
 */
export function detectionMetrics(
  preds: Box[],
  refs: Box[],
  caseIds: string[],
  iouThreshold = 0.3
): DetectionResult {
  const groupByCase = (boxes: Box[]): Map<string, Box[]> => {
    const m = new Map<string, Box[]>();
    for (const b of boxes) {
      const bucket = m.get(b.caseId);
      if (bucket) bucket.push(b);
      else m.set(b.caseId, [b]);
    }
    return m;
  };
  const predsByCase = groupByCase(preds);
  const refsByCase = groupByCase(refs);

  const outcomes: MatchOutcome[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let locSum = 0;
  for (const caseId of caseIds) {
    const cp = predsByCase.get(caseId) ?? [];
    const cr = refsByCase.get(caseId) ?? [];
    const { outcomes: cout, fn: cfn } = matchCase(cp, cr, iouThreshold);
    fn += cfn;
    for (const o of cout) {
      outcomes.push(o);
      if (o.isTp) {
        tp++;
        locSum += o.locErr;
      } else {
        fp++;
      }
    }
  }

  const totalRefs = tp + fn;
  const numImages = caseIds.length;
  const lesionSensitivity = totalRefs === 0 ? 0 : tp / totalRefs;
  const fpPerImage = numImages === 0 ? 0 : fp / numImages;
  const localizationErrorMean = tp === 0 ? 0 : locSum / tp;
  const meanAp = averagePrecision(outcomes, totalRefs);

  // FROC: unique prediction scores (descending) plus a 0 threshold (all preds).
  const thresholdSet = new Set<number>(outcomes.map((o) => o.score));
  thresholdSet.add(0);
  const thresholds = [...thresholdSet].sort((a, b) => b - a);
  const froc = thresholds
    .map((thr) => {
      let tpAt = 0;
      let fpAt = 0;
      for (const o of outcomes) {
        if (o.score < thr) continue;
        if (o.isTp) tpAt++;
        else fpAt++;
      }
      return {
        scoreThreshold: thr,
        sensitivity: totalRefs === 0 ? 0 : tpAt / totalRefs,
        fpPerImage: numImages === 0 ? 0 : fpAt / numImages,
      };
    })
    .sort((a, b) => a.fpPerImage - b.fpPerImage);

  return { tp, fp, fn, lesionSensitivity, fpPerImage, meanAp, localizationErrorMean, froc };
}
