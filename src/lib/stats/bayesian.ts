/**
 * Bayesian correlated t-test for comparing two models on cross-validation
 * (Benavoli, Corani, Demšar & Zaffalon 2017, "Time for a change"). Instead of a
 * single p-value it returns the posterior probabilities that model A is
 * practically worse / equivalent / better than B, using a Region Of Practical
 * Equivalence (ROPE). The posterior is a Student-t with the same Nadeau-Bengio
 * correlation correction as the frequentist corrected t-test.
 *
 * Reuses the Student-t CDF from ./corrected-tests. Pure, no dependencies.
 */

import { studentTCdf } from './corrected-tests';

export interface BayesianResult {
  meanDiff: number;
  /** P(θ < −rope): A practically worse than B. */
  pLeft: number;
  /** P(|θ| ≤ rope): A and B practically equivalent. */
  pRope: number;
  /** P(θ > rope): A practically better than B. */
  pRight: number;
  rope: number;
  rho: number;
  df: number;
}

function mean(d: readonly number[]): number {
  return d.reduce((a, b) => a + b, 0) / d.length;
}
function sampleVariance(d: readonly number[]): number {
  const n = d.length;
  const m = mean(d);
  return d.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1);
}

/** Correlation for repeated train/test resampling: ρ = n_test / (n_train + n_test). */
export function rhoFromSizes(nTrain: number, nTest: number): number {
  return nTest / (nTrain + nTest);
}

/**
 * Bayesian correlated t-test on paired differences `d` (A − B), with heldout
 * correlation `rho` (e.g. `rhoFromSizes(n1, n2)`, or `1/k` for k-fold) and a
 * ROPE half-width `rope` (practical-equivalence threshold on the metric).
 */
export function bayesianCorrelatedTtest(
  d: readonly number[],
  rho: number,
  rope: number
): BayesianResult {
  if (d.length < 2) throw new Error('bayesianCorrelatedTtest: need at least 2 differences.');
  if (!(rho > 0 && rho < 1)) throw new Error('rho must be in (0, 1).');
  if (rope < 0) throw new Error('rope must be ≥ 0.');
  const n = d.length;
  const mu = mean(d);
  const s2 = sampleVariance(d);
  const scale = Math.sqrt((1 / n + rho / (1 - rho)) * s2);
  const df = n - 1;
  if (scale === 0) {
    // Degenerate: all differences identical → point mass at mu.
    return {
      meanDiff: mu,
      pLeft: mu < -rope ? 1 : 0,
      pRope: Math.abs(mu) <= rope ? 1 : 0,
      pRight: mu > rope ? 1 : 0,
      rope,
      rho,
      df,
    };
  }
  const cdfL = studentTCdf((-rope - mu) / scale, df);
  const cdfR = studentTCdf((rope - mu) / scale, df);
  return {
    meanDiff: mu,
    pLeft: cdfL,
    pRope: cdfR - cdfL,
    pRight: 1 - cdfR,
    rope,
    rho,
    df,
  };
}
