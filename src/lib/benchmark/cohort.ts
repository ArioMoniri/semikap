/**
 * Cohort construction (Phase 3): group benchmark records into subgroups by
 * filtering on case-level DICOM/exam metadata (modality, body part, contrast,
 * manufacturer, sex, age). Pure functions — no DOM/network/PHI beyond what the
 * records already carry.
 */

import type { BenchmarkRecord } from './types';

/**
 * A predicate over case metadata. A field constrains the match only when it is
 * defined; undefined fields impose no constraint.
 */
export interface CohortFilter {
  /** Exact match against `r.case.meta.modality`. */
  modality?: string;
  /** Exact match against `r.case.meta.bodyPart`. */
  bodyPart?: string;
  /** Strict-equality match against `r.case.meta.contrast`. */
  contrast?: boolean;
  /** Exact match against `r.case.meta.manufacturer`. */
  manufacturer?: string;
  /** `r.case.meta.sex` must be one of these values. */
  sexIn?: ('M' | 'F' | 'O')[];
  /** Inclusive lower bound on `r.case.meta.ageYears`. */
  ageMin?: number;
  /** Inclusive upper bound on `r.case.meta.ageYears`. */
  ageMax?: number;
}

/** A named cohort: a human-readable label paired with its filter predicate. */
export interface Cohort {
  name: string;
  filter: CohortFilter;
}

/**
 * Returns true when record `r` satisfies every constraint defined in `f`; a
 * constraint on a field the record's meta lacks fails the match.
 */
export function matchesCohort(r: BenchmarkRecord, f: CohortFilter): boolean {
  const meta = r.case.meta;

  if (f.modality !== undefined) {
    if (meta?.modality !== f.modality) return false;
  }
  if (f.bodyPart !== undefined) {
    if (meta?.bodyPart !== f.bodyPart) return false;
  }
  if (f.contrast !== undefined) {
    if (meta?.contrast !== f.contrast) return false;
  }
  if (f.manufacturer !== undefined) {
    if (meta?.manufacturer !== f.manufacturer) return false;
  }
  if (f.sexIn !== undefined) {
    const sex = meta?.sex;
    if (sex === undefined || !f.sexIn.includes(sex)) return false;
  }
  if (f.ageMin !== undefined) {
    const age = meta?.ageYears;
    if (age === undefined || age < f.ageMin) return false;
  }
  if (f.ageMax !== undefined) {
    const age = meta?.ageYears;
    if (age === undefined || age > f.ageMax) return false;
  }
  return true;
}

/** Returns the subset of `records` matching filter `f`, preserving order. */
export function filterByCohort(records: BenchmarkRecord[], f: CohortFilter): BenchmarkRecord[] {
  return records.filter((r) => matchesCohort(r, f));
}
