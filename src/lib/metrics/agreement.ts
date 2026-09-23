/**
 * Agreement statistics for benchmark reports: ICC(A,1) for volume agreement
 * and the Wilson score interval for lesion-detection sensitivity.
 */

/**
 * ICC(A,1) — two-way random effects, absolute agreement, single rater
 * (McGraw & Wong 1996; = Shrout & Fleiss ICC(2,1)). `x` is n targets × k raters.
 * NaN with fewer than 2 targets or 2 raters.
 */
export function iccA1(x: readonly (readonly number[])[]): number {
  const n = x.length;
  const k = x[0]?.length ?? 0;
  if (n < 2 || k < 2) return NaN;
  const gm = x.flat().reduce((a, b) => a + b, 0) / (n * k);
  const rowMeans = x.map((r) => r.reduce((a, b) => a + b, 0) / k);
  const colMeans = Array.from({ length: k }, (_, j) => x.reduce((a, r) => a + r[j]!, 0) / n);
  const ssr = k * rowMeans.reduce((a, m) => a + (m - gm) ** 2, 0);
  const ssc = n * colMeans.reduce((a, m) => a + (m - gm) ** 2, 0);
  const sst = x.flat().reduce((a, v) => a + (v - gm) ** 2, 0);
  const msr = ssr / (n - 1);
  const msc = ssc / (k - 1);
  const mse = (sst - ssr - ssc) / ((n - 1) * (k - 1));
  return (msr - mse) / (msr + (k - 1) * mse + (k * (msc - mse)) / n);
}

/** Wilson score 95% interval for k successes out of n (NaN when n = 0). */
export function wilsonInterval(k: number, n: number, z = 1.959964): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
