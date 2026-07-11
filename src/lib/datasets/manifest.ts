/**
 * Dataset / reference-label manifest for local benchmarking.
 *
 * A dataset describes a set of imaging cases and their ground-truth references,
 * so a registered model can be scored against them. Fields are inspired by the
 * ACR Assess-AI Data Dictionary (modality, body part, study date, contrast,
 * de-identified case key) but the manifest itself carries only names + metadata
 * — never PHI bytes. Segmentation references point at a mask file (NIfTI/NRRD);
 * classification references carry a per-case 0/1 label.
 *
 * The parser is intentionally strict, mirroring `src/lib/inference/manifest.ts`.
 */

import type { Modality } from '../../types';

export type BenchmarkTask = 'segmentation' | 'classification';

export interface CaseManifest {
  /** De-identified local case key (Assess-AI "case ID"). */
  caseId: string;
  /** Image file name within the dataset bundle. */
  imageName: string;
  /** Ground-truth mask file name (segmentation task). */
  referenceLabelName?: string;
  /** Ground-truth class 0/1 (classification task). */
  referenceClass?: number;
  modality?: Modality;
  bodyPart?: string;
  /** Study date, YYYYMMDD. */
  studyDate?: string;
  contrast?: boolean;
  /** Whether a usable ground truth is present for this case. */
  groundTruthAvailable: boolean;
  notes?: string;
}

export interface DatasetManifest {
  schema: 'tamias.dataset.v1';
  name: string;
  task: BenchmarkTask;
  /** Segmentation label map {index: name}; foreground labels scored. */
  labels?: Record<number, string>;
  cases: CaseManifest[];
}

export function parseDatasetManifest(raw: unknown): DatasetManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Dataset manifest must be a JSON object.');
  }
  const m = raw as Record<string, unknown>;
  if (m.schema !== 'tamias.dataset.v1') {
    throw new Error('Dataset manifest "schema" must be "tamias.dataset.v1".');
  }
  const name = expectString(m, 'name');
  const task = m.task;
  if (task !== 'segmentation' && task !== 'classification') {
    throw new Error('Dataset manifest "task" must be "segmentation" or "classification".');
  }

  let labels: Record<number, string> | undefined;
  if (m.labels !== undefined) {
    if (typeof m.labels !== 'object' || m.labels === null) {
      throw new Error('Dataset manifest "labels" must be an object {index: name}.');
    }
    labels = {};
    for (const [k, v] of Object.entries(m.labels)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new Error(`Dataset label index "${k}" must be a non-negative integer.`);
      }
      if (typeof v !== 'string') throw new Error(`Dataset label "${k}" name must be a string.`);
      labels[idx] = v;
    }
  }

  const casesRaw = m.cases;
  if (!Array.isArray(casesRaw) || casesRaw.length === 0) {
    throw new Error('Dataset manifest "cases" must be a non-empty array.');
  }
  const seen = new Set<string>();
  const cases: CaseManifest[] = casesRaw.map((c, i) => parseCase(c, i, task, seen));

  return {
    schema: 'tamias.dataset.v1',
    name,
    task,
    ...(labels ? { labels } : {}),
    cases,
  };
}

function parseCase(
  raw: unknown,
  index: number,
  task: BenchmarkTask,
  seen: Set<string>
): CaseManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Dataset case #${index} must be an object.`);
  }
  const c = raw as Record<string, unknown>;
  const caseId = expectString(c, 'caseId', `case #${index}`);
  if (seen.has(caseId)) throw new Error(`Duplicate caseId "${caseId}".`);
  seen.add(caseId);
  const imageName = expectString(c, 'imageName', `case "${caseId}"`);

  const out: CaseManifest = { caseId, imageName, groundTruthAvailable: false };

  if (c.referenceLabelName !== undefined) {
    if (typeof c.referenceLabelName !== 'string') {
      throw new Error(`Case "${caseId}" referenceLabelName must be a string.`);
    }
    out.referenceLabelName = c.referenceLabelName;
  }
  if (c.referenceClass !== undefined) {
    if (c.referenceClass !== 0 && c.referenceClass !== 1) {
      throw new Error(`Case "${caseId}" referenceClass must be 0 or 1.`);
    }
    out.referenceClass = c.referenceClass;
  }
  if (c.modality !== undefined) {
    const allowed = ['CT', 'MR', 'PT', 'XR', 'US', 'Other'];
    if (typeof c.modality !== 'string' || !allowed.includes(c.modality)) {
      throw new Error(`Case "${caseId}" modality must be one of ${allowed.join('|')}.`);
    }
    out.modality = c.modality as Modality;
  }
  if (c.bodyPart !== undefined) {
    if (typeof c.bodyPart !== 'string') throw new Error(`Case "${caseId}" bodyPart must be a string.`);
    out.bodyPart = c.bodyPart;
  }
  if (c.studyDate !== undefined) {
    if (typeof c.studyDate !== 'string' || !/^\d{8}$/.test(c.studyDate)) {
      throw new Error(`Case "${caseId}" studyDate must be YYYYMMDD.`);
    }
    out.studyDate = c.studyDate;
  }
  if (c.contrast !== undefined) {
    if (typeof c.contrast !== 'boolean') throw new Error(`Case "${caseId}" contrast must be boolean.`);
    out.contrast = c.contrast;
  }
  if (c.notes !== undefined) {
    if (typeof c.notes !== 'string') throw new Error(`Case "${caseId}" notes must be a string.`);
    out.notes = c.notes;
  }

  // Derive/validate groundTruthAvailable against the task.
  const hasRef =
    task === 'segmentation'
      ? typeof out.referenceLabelName === 'string'
      : out.referenceClass !== undefined;
  if (c.groundTruthAvailable !== undefined) {
    if (typeof c.groundTruthAvailable !== 'boolean') {
      throw new Error(`Case "${caseId}" groundTruthAvailable must be boolean.`);
    }
    out.groundTruthAvailable = c.groundTruthAvailable && hasRef;
  } else {
    out.groundTruthAvailable = hasRef;
  }

  return out;
}

export interface DatasetCompleteness {
  totalCases: number;
  withGroundTruth: number;
  /** Fraction of cases with a usable reference (Assess-AI accrual-style). */
  completeness: number;
}

/** Accrual/completeness summary of a dataset (how many cases are scorable). */
export function datasetCompleteness(ds: DatasetManifest): DatasetCompleteness {
  const total = ds.cases.length;
  const withGt = ds.cases.filter((c) => c.groundTruthAvailable).length;
  return {
    totalCases: total,
    withGroundTruth: withGt,
    completeness: total === 0 ? 0 : withGt / total,
  };
}

function expectString(o: Record<string, unknown>, key: string, ctx = 'manifest'): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Dataset ${ctx} "${key}" must be a non-empty string.`);
  }
  return v;
}
