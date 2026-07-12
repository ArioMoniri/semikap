/**
 * Agreement plots for segmentation volumes (doc §5).
 *
 * Provides Bland-Altman analysis and Pearson volume correlation over paired
 * reference/predicted measurements (e.g. lesion or organ volumes in mL). All
 * functions are pure — no DOM, network, or global state.
 *
 * Convention: for each pair the difference is `pred - ref` and the plotting
 * abscissa is the pair mean `(ref + pred) / 2`.
 */

/** A single reference/prediction measurement pair (e.g. volume in mL). */
export interface Pair {
  ref: number;
  pred: number;
}

/** Bland-Altman summary: per-pair points plus bias and 95% limits of agreement. */
export interface BlandAltman {
  points: { mean: number; diff: number }[];
  bias: number;
  sdDiff: number;
  loaLow: number;
  loaHigh: number;
}

const LOA_Z = 1.96;

/**
 * Compute a Bland-Altman summary: diff = pred-ref, mean = (ref+pred)/2, bias =
 * mean(diff), sdDiff = sample SD (n-1), LoA = bias ± 1.96·sdDiff.
 */
export function blandAltman(pairs: readonly Pair[]): BlandAltman {
  const n = pairs.length;
  const points = pairs.map((p) => ({
    mean: (p.ref + p.pred) / 2,
    diff: p.pred - p.ref,
  }));

  if (n === 0) {
    return { points, bias: NaN, sdDiff: NaN, loaLow: NaN, loaHigh: NaN };
  }

  let sum = 0;
  for (let i = 0; i < n; i++) sum += points[i]!.diff;
  const bias = sum / n;

  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = points[i]!.diff - bias;
    sq += d * d;
  }
  const sdDiff = n < 2 ? NaN : Math.sqrt(sq / (n - 1));

  return {
    points,
    bias,
    sdDiff,
    loaLow: bias - LOA_Z * sdDiff,
    loaHigh: bias + LOA_Z * sdDiff,
  };
}

/**
 * Pearson correlation coefficient of `ref` vs `pred`; NaN if fewer than two
 * pairs or either side has zero variance.
 */
export function pearson(pairs: readonly Pair[]): number {
  const n = pairs.length;
  if (n < 2) return NaN;

  let sumRef = 0;
  let sumPred = 0;
  for (let i = 0; i < n; i++) {
    sumRef += pairs[i]!.ref;
    sumPred += pairs[i]!.pred;
  }
  const meanRef = sumRef / n;
  const meanPred = sumPred / n;

  let cov = 0;
  let varRef = 0;
  let varPred = 0;
  for (let i = 0; i < n; i++) {
    const dr = pairs[i]!.ref - meanRef;
    const dp = pairs[i]!.pred - meanPred;
    cov += dr * dp;
    varRef += dr * dr;
    varPred += dp * dp;
  }

  if (varRef === 0 || varPred === 0) return NaN;
  return cov / Math.sqrt(varRef * varPred);
}
