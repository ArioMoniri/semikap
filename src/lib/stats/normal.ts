/**
 * Standard-normal helpers (erf-based), shared by the z-based comparison tests
 * (DeLong, McNemar, Wilcoxon normal approximation). Pure, no dependencies.
 */

/** Error function via Abramowitz & Stegun 7.1.26 (|abs err| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard-normal CDF Φ(z). */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Two-tailed normal p-value = 2·Φ(−|z|). */
export function normalTwoTailedP(z: number): number {
  if (!Number.isFinite(z)) return NaN;
  return 2 * normalCdf(-Math.abs(z));
}
