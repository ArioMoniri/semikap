/**
 * Extract Assess-AI DICOM metadata fields from a parsed DICOM tag map into a
 * `CaseMeta`, so a benchmark case can carry cohort/subgroup metadata without
 * ever storing PHI bytes. Pure: takes a plain tag->value map, returns metadata.
 *
 * `tags` keys are 8-hex-digit DICOM tags (group+element, upper-hex, no comma,
 * e.g. `'00080060'`). Values are the raw parsed element values (usually
 * strings). Only recognized, well-formed fields are emitted; anything missing,
 * empty, or malformed is omitted (the corresponding key is never set).
 */

import type { CaseMeta } from './manifest';
import type { Modality } from '../../types';

/** Coerce a raw tag value to a trimmed non-empty string, or undefined. */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/**
 * Normalize a raw DICOM Modality string to a TAMIAS `Modality`. `DX`/`CR` map
 * to `XR`; `CT`/`MR`/`PT`/`US`/`XR` pass through; anything else -> `Other`.
 */
export function normalizeModality(raw: string): Modality {
  const m = raw.trim().toUpperCase();
  switch (m) {
    case 'DX':
    case 'CR':
    case 'XR':
      return 'XR';
    case 'CT':
      return 'CT';
    case 'MR':
      return 'MR';
    case 'PT':
      return 'PT';
    case 'US':
      return 'US';
    default:
      return 'Other';
  }
}

/**
 * Parse a DICOM PatientAge string (`nnnU`, e.g. `'045Y'`) to whole years. Only
 * the `Y` (years) unit is honored -> the numeric part; all other units (`M`,
 * `W`, `D`) and malformed values return undefined.
 */
export function parseAgeYears(raw: string): number | undefined {
  const m = /^(\d{1,3})Y$/.exec(raw.trim().toUpperCase());
  if (!m) return undefined;
  return Number(m[1]!);
}

/**
 * Extract Assess-AI `CaseMeta` fields from a parsed DICOM tag map, omitting any
 * field that is absent, empty, or malformed (never sets an undefined value).
 */
export function extractCaseMeta(tags: Record<string, unknown>): CaseMeta {
  const meta: CaseMeta = {};

  const modalityRaw = asText(tags['00080060']);
  if (modalityRaw !== undefined) {
    meta.modality = normalizeModality(modalityRaw);
  }

  const bodyPart = asText(tags['00180015']);
  if (bodyPart !== undefined) meta.bodyPart = bodyPart;

  const manufacturer = asText(tags['00080070']);
  if (manufacturer !== undefined) meta.manufacturer = manufacturer;

  const modelName = asText(tags['00081090']);
  if (modelName !== undefined) meta.modelName = modelName;

  const stationName = asText(tags['00081010']);
  if (stationName !== undefined) meta.stationName = stationName;

  const softwareVersion = asText(tags['00181020']);
  if (softwareVersion !== undefined) meta.softwareVersion = softwareVersion;

  const thicknessRaw = asText(tags['00180050']);
  if (thicknessRaw !== undefined) {
    const thickness = Number(thicknessRaw);
    if (!Number.isNaN(thickness)) meta.sliceThicknessMm = thickness;
  }

  const studyDate = asText(tags['00080020']);
  if (studyDate !== undefined && /^\d{8}$/.test(studyDate)) {
    meta.studyDate = studyDate;
  }

  const sexRaw = asText(tags['00100040']);
  if (sexRaw !== undefined) {
    const sex = sexRaw.toUpperCase();
    if (sex === 'M' || sex === 'F' || sex === 'O') meta.sex = sex;
  }

  const ageRaw = asText(tags['00101010']);
  if (ageRaw !== undefined) {
    const age = parseAgeYears(ageRaw);
    if (age !== undefined) meta.ageYears = age;
  }

  const contrastRaw = asText(tags['00180010']);
  if (contrastRaw !== undefined) {
    meta.contrast = contrastRaw.toUpperCase() !== 'NO';
  }

  return meta;
}
