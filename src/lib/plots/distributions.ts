/**
 * Distribution and forest-plot data helpers (doc §5: runtime distribution and
 * subgroup forest plots).
 *
 * Pure module: no DOM, no network. Consumers turn these plain arrays into SVG
 * bars / forest rows in the UI layer.
 */

/** A single histogram bucket spanning the half-open interval [x0, x1). */
export interface Bin {
  x0: number;
  x1: number;
  count: number;
}

/**
 * Bucket `values` into `bins` equal-width bins over [min, max] (default 10).
 *
 * Returns [] for empty input. When every value is equal (zero range), returns a
 * single degenerate bin [v, v] holding every value. The final bin is closed on
 * the right so the maximum value is counted. NaN values are ignored.
 */
export function histogram(values: number[], bins = 10): Bin[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [];
  const n = Math.max(1, Math.floor(bins));
  let min = finite[0]!;
  let max = finite[0]!;
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return [{ x0: min, x1: max, count: finite.length }];
  }
  const width = (max - min) / n;
  const out: Bin[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ x0: min + i * width, x1: min + (i + 1) * width, count: 0 });
  }
  for (const v of finite) {
    let idx = Math.floor((v - min) / width);
    if (idx >= n) idx = n - 1; // include the max in the last bin
    if (idx < 0) idx = 0;
    out[idx]!.count += 1;
  }
  return out;
}

/** One row of a forest plot: a point estimate with a 95% confidence interval. */
export interface ForestRow {
  label: string;
  value: number;
  low: number;
  high: number;
  n: number;
}

/**
 * Build forest-plot rows from labelled groups: value=mean, 95% CI=mean ± 1.96·se
 * where se = sample-sd / sqrt(n). NaN values are ignored; n is the finite count.
 *
 * Empty `groups` yields []. A group with n<2 has se=0 (low=high=mean); a group
 * with n=0 yields value/low/high = NaN.
 */
export function forestFromGroups(groups: { label: string; values: number[] }[]): ForestRow[] {
  return groups.map(({ label, values }) => {
    const finite = values.filter((v) => Number.isFinite(v));
    const n = finite.length;
    if (n === 0) {
      return { label, value: NaN, low: NaN, high: NaN, n: 0 };
    }
    const mean = finite.reduce((a, b) => a + b, 0) / n;
    let se = 0;
    if (n >= 2) {
      const variance = finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
      se = Math.sqrt(variance) / Math.sqrt(n);
    }
    const half = 1.96 * se;
    return { label, value: mean, low: mean - half, high: mean + half, n };
  });
}
