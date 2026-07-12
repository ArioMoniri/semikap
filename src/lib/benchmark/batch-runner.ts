/**
 * Sequential batch orchestration for the "run two models on many images" flow.
 *
 * The heavy work (decode a NIfTI volume, run inference in a worker, score vs a
 * reference, compute a mask-diff) is injected as a single `runOne` callback so
 * this module stays pure and unit-testable. The orchestrator's job is the part
 * that is easy to get wrong:
 *
 *  - process cases strictly ONE AT A TIME (so we never hold 20 decoded volumes
 *    in memory — the caller's `runOne` decodes + frees within its own scope),
 *  - isolate a failing case (record the error, keep going),
 *  - report progress before and after each case,
 *  - support cooperative cancellation between cases.
 *
 * No I/O, no workers, no DOM here.
 */

import type { BatchCase } from './batch';
import type { BenchmarkRecord } from './types';

/** Compact agreement summary for one case's two model masks. */
export interface CaseDiffSummary {
  both: number;
  aOnly: number;
  bOnly: number;
  agreeFraction: number;
}

/** Outcome of processing a single batch case. */
export interface BatchCaseOutcome {
  caseId: string;
  imageName: string;
  /** Records produced (typically one per model when a reference was scored). */
  records: BenchmarkRecord[];
  /** Model-vs-model agreement summary, when both masks were produced. */
  diff?: CaseDiffSummary;
  /** Whether a ground-truth reference was available and scored. */
  scored: boolean;
  /** Error message if this case failed (its records are then empty). */
  error?: string;
}

/** Progress emitted around each case. */
export interface BatchProgress {
  /** 0-based index of the case currently being processed. */
  index: number;
  /** Total number of cases. */
  total: number;
  caseId: string;
  phase: 'start' | 'done' | 'error';
}

/** What {@link runBatch} needs from the caller for one case. */
export type RunOne = (batchCase: BatchCase, index: number) => Promise<Omit<BatchCaseOutcome, 'caseId' | 'imageName'>>;

/** Options for {@link runBatch}. */
export interface RunBatchOptions {
  onProgress?: (p: BatchProgress) => void;
  /** Return true to stop before the next case starts (already-run cases are kept). */
  shouldCancel?: () => boolean;
}

/**
 * Run `runOne` over `cases` sequentially, isolating per-case failures and
 * reporting progress. Resolves with one {@link BatchCaseOutcome} per case that
 * was attempted (cancellation truncates the tail).
 *
 * @param cases - Paired batch cases (see {@link pairImagesAndMasks}).
 * @param runOne - Async per-case worker supplied by the caller.
 * @param opts - Progress + cancellation hooks.
 */
export async function runBatch(
  cases: readonly BatchCase[],
  runOne: RunOne,
  opts: RunBatchOptions = {},
): Promise<BatchCaseOutcome[]> {
  const outcomes: BatchCaseOutcome[] = [];
  for (let i = 0; i < cases.length; i++) {
    if (opts.shouldCancel?.()) break;
    const c = cases[i]!;
    opts.onProgress?.({ index: i, total: cases.length, caseId: c.caseId, phase: 'start' });
    try {
      const partial = await runOne(c, i);
      outcomes.push({ caseId: c.caseId, imageName: c.imageName, ...partial });
      opts.onProgress?.({ index: i, total: cases.length, caseId: c.caseId, phase: 'done' });
    } catch (e) {
      outcomes.push({
        caseId: c.caseId,
        imageName: c.imageName,
        records: [],
        scored: false,
        error: (e as Error).message,
      });
      opts.onProgress?.({ index: i, total: cases.length, caseId: c.caseId, phase: 'error' });
    }
  }
  return outcomes;
}

/** Flatten all records produced across a batch (for adding to the store). */
export function collectRecords(outcomes: readonly BatchCaseOutcome[]): BenchmarkRecord[] {
  const out: BenchmarkRecord[] = [];
  for (const o of outcomes) out.push(...o.records);
  return out;
}

/** Count successes / failures / scored across a batch. */
export function summarizeBatch(outcomes: readonly BatchCaseOutcome[]): {
  total: number;
  ok: number;
  failed: number;
  scored: number;
} {
  let ok = 0;
  let failed = 0;
  let scored = 0;
  for (const o of outcomes) {
    if (o.error) failed++;
    else ok++;
    if (o.scored) scored++;
  }
  return { total: outcomes.length, ok, failed, scored };
}
