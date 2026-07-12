import type { BenchmarkRecord } from './types';

/**
 * Per-case completeness flags: whether the record carries an AI result,
 * DICOM/exam metadata, and a reference/ground-truth, plus whether all three are present.
 */
export interface CaseCompleteness {
  caseId: string;
  hasAiResult: boolean;
  hasDicomMeta: boolean;
  hasReference: boolean;
  complete: boolean;
}

/**
 * Aggregate completeness counts across a set of benchmark records, including the
 * fraction of cases that are fully complete (0 when there are no records).
 */
export interface CompletenessSummary {
  total: number;
  withAiResult: number;
  withDicomMeta: number;
  withReference: number;
  complete: number;
  completeFraction: number;
}

/** Assess a single benchmark record's AI-result / metadata / reference presence. */
export function recordCompleteness(r: BenchmarkRecord): CaseCompleteness {
  const hasAiResult = !!(r.segmentation?.length || r.classification || r.case.aiResult);
  const hasDicomMeta = !!r.case.meta;
  const hasReference = !!(r.case.referenceName || r.case.referenceResult);
  return {
    caseId: r.case.caseId,
    hasAiResult,
    hasDicomMeta,
    hasReference,
    complete: hasAiResult && hasDicomMeta && hasReference,
  };
}

/** Compute per-case completeness rows and an aggregate summary for a set of records. */
export function summarizeCompleteness(
  records: BenchmarkRecord[],
): { rows: CaseCompleteness[]; summary: CompletenessSummary } {
  const rows = records.map(recordCompleteness);
  const total = rows.length;
  let withAiResult = 0;
  let withDicomMeta = 0;
  let withReference = 0;
  let complete = 0;
  for (const row of rows) {
    if (row.hasAiResult) withAiResult++;
    if (row.hasDicomMeta) withDicomMeta++;
    if (row.hasReference) withReference++;
    if (row.complete) complete++;
  }
  const summary: CompletenessSummary = {
    total,
    withAiResult,
    withDicomMeta,
    withReference,
    complete,
    completeFraction: total === 0 ? 0 : complete / total,
  };
  return { rows, summary };
}
