import type { BenchmarkRecord } from './types';

/**
 * A single AI-vs-reference outcome pair for one case.
 */
export interface ConcordancePair {
  caseId: string;
  aiResult: string;
  referenceResult: string;
}

/**
 * Aggregate concordance statistics with a Wilson 95% confidence interval.
 */
export interface ConcordanceResult {
  total: number;
  concordant: number;
  discordant: number;
  rate: number;
  ciLow: number;
  ciHigh: number;
  discordantCaseIds: string[];
}

const Z_95 = 1.959964;

/** Clamp `x` into the closed unit interval [0, 1]. */
function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * computeConcordance — count case-sensitive (trimmed) AI/reference agreement
 * and return the concordance rate with a Wilson score 95% CI (zeros if empty).
 */
export function computeConcordance(pairs: ConcordancePair[]): ConcordanceResult {
  const total = pairs.length;
  const discordantCaseIds: string[] = [];
  let concordant = 0;
  for (let i = 0; i < total; i++) {
    const p = pairs[i]!;
    if (p.aiResult.trim() === p.referenceResult.trim()) {
      concordant += 1;
    } else {
      discordantCaseIds.push(p.caseId);
    }
  }
  const discordant = total - concordant;
  if (total === 0) {
    return { total: 0, concordant: 0, discordant: 0, rate: 0, ciLow: 0, ciHigh: 0, discordantCaseIds };
  }
  const rate = concordant / total;
  const z = Z_95;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (rate + z2 / (2 * total)) / denom;
  const margin =
    (z / denom) * Math.sqrt((rate * (1 - rate)) / total + z2 / (4 * total * total));
  return {
    total,
    concordant,
    discordant,
    rate,
    ciLow: clamp01(center - margin),
    ciHigh: clamp01(center + margin),
    discordantCaseIds,
  };
}

/**
 * concordanceFromRecords — derive concordance from benchmark records that carry
 * both a defined `case.aiResult` and `case.referenceResult`.
 */
export function concordanceFromRecords(records: BenchmarkRecord[]): ConcordanceResult {
  const pairs: ConcordancePair[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const ai = r.case.aiResult;
    const ref = r.case.referenceResult;
    if (ai !== undefined && ref !== undefined) {
      pairs.push({ caseId: r.case.caseId, aiResult: ai, referenceResult: ref });
    }
  }
  return computeConcordance(pairs);
}
