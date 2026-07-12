import { describe, expect, it } from 'vitest';
import { filterByCohort, matchesCohort } from '../src/lib/benchmark/cohort';
import type { CohortFilter } from '../src/lib/benchmark/cohort';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';
import type { CaseMeta } from '../src/lib/datasets/manifest';

/** Build a minimal valid BenchmarkRecord carrying the given case meta. */
function rec(id: string, meta?: CaseMeta): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id,
    profileId: 'p1',
    datasetName: 'ds',
    task: 'segmentation',
    model: { name: 'm', version: '1', sha256: 'abc' },
    case: { caseId: id, imageName: `${id}.nii`, meta },
    runtime: { provider: 'wasm', inferMs: 1, totalMs: 1 },
    createdAt: '2026-01-01T00:00:00Z',
    appVersion: '0.10.0',
  };
}

describe('matchesCohort', () => {
  it('empty filter matches any record', () => {
    expect(matchesCohort(rec('a'), {})).toBe(true);
    expect(matchesCohort(rec('b', { modality: 'CT' }), {})).toBe(true);
  });

  it('modality: exact match required', () => {
    const r = rec('a', { modality: 'CT' });
    expect(matchesCohort(r, { modality: 'CT' })).toBe(true);
    expect(matchesCohort(r, { modality: 'MR' })).toBe(false);
  });

  it('constrained field missing from meta -> no match', () => {
    expect(matchesCohort(rec('a', {}), { modality: 'CT' })).toBe(false);
    expect(matchesCohort(rec('a'), { modality: 'CT' })).toBe(false);
    expect(matchesCohort(rec('a', {}), { contrast: false })).toBe(false);
    expect(matchesCohort(rec('a'), { sexIn: ['M'] })).toBe(false);
    expect(matchesCohort(rec('a'), { ageMin: 0 })).toBe(false);
  });

  it('contrast: strict equality (false !== undefined)', () => {
    expect(matchesCohort(rec('a', { contrast: true }), { contrast: true })).toBe(true);
    expect(matchesCohort(rec('a', { contrast: false }), { contrast: false })).toBe(true);
    expect(matchesCohort(rec('a', { contrast: true }), { contrast: false })).toBe(false);
    expect(matchesCohort(rec('a', { contrast: false }), { contrast: true })).toBe(false);
  });

  it('sexIn: membership test', () => {
    expect(matchesCohort(rec('a', { sex: 'F' }), { sexIn: ['F', 'O'] })).toBe(true);
    expect(matchesCohort(rec('a', { sex: 'M' }), { sexIn: ['F', 'O'] })).toBe(false);
    expect(matchesCohort(rec('a', { sex: 'M' }), { sexIn: [] })).toBe(false);
  });

  it('ageMin/ageMax: inclusive bounds', () => {
    const r = rec('a', { ageYears: 50 });
    expect(matchesCohort(r, { ageMin: 50 })).toBe(true); // inclusive lower
    expect(matchesCohort(r, { ageMax: 50 })).toBe(true); // inclusive upper
    expect(matchesCohort(r, { ageMin: 51 })).toBe(false);
    expect(matchesCohort(r, { ageMax: 49 })).toBe(false);
    expect(matchesCohort(r, { ageMin: 18, ageMax: 65 })).toBe(true);
    expect(matchesCohort(rec('b', { ageYears: 10 }), { ageMin: 18, ageMax: 65 })).toBe(false);
  });

  it('multiple constraints combine with AND', () => {
    const r = rec('a', { modality: 'CT', sex: 'M', ageYears: 40, contrast: true });
    expect(matchesCohort(r, { modality: 'CT', sexIn: ['M'], ageMin: 30, ageMax: 50, contrast: true })).toBe(true);
    expect(matchesCohort(r, { modality: 'CT', sexIn: ['F'] })).toBe(false);
  });
});

describe('filterByCohort', () => {
  const records: BenchmarkRecord[] = [
    rec('ct-m-40', { modality: 'CT', sex: 'M', ageYears: 40 }),
    rec('mr-f-60', { modality: 'MR', sex: 'F', ageYears: 60 }),
    rec('ct-f-25', { modality: 'CT', sex: 'F', ageYears: 25 }),
    rec('no-meta'),
  ];

  it('empty filter returns all', () => {
    expect(filterByCohort(records, {}).map((r) => r.id)).toEqual([
      'ct-m-40',
      'mr-f-60',
      'ct-f-25',
      'no-meta',
    ]);
  });

  it('filter by modality, preserving order', () => {
    expect(filterByCohort(records, { modality: 'CT' }).map((r) => r.id)).toEqual([
      'ct-m-40',
      'ct-f-25',
    ]);
  });

  it('filter by age range', () => {
    expect(filterByCohort(records, { ageMin: 30, ageMax: 65 }).map((r) => r.id)).toEqual([
      'ct-m-40',
      'mr-f-60',
    ]);
  });

  it('filter by sexIn', () => {
    expect(filterByCohort(records, { sexIn: ['F'] }).map((r) => r.id)).toEqual([
      'mr-f-60',
      'ct-f-25',
    ]);
  });

  it('records lacking constrained meta are excluded', () => {
    const f: CohortFilter = { modality: 'CT' };
    expect(filterByCohort(records, f).some((r) => r.id === 'no-meta')).toBe(false);
  });
});
