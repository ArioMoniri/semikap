import { describe, expect, it } from 'vitest';
import {
  computeConcordance,
  concordanceFromRecords,
  type ConcordancePair,
} from '../src/lib/benchmark/concordance';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';

function pair(caseId: string, ai: string, ref: string): ConcordancePair {
  return { caseId, aiResult: ai, referenceResult: ref };
}

function record(caseId: string, ai: string | undefined, ref: string | undefined): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id: `rec-${caseId}`,
    profileId: 'p1',
    datasetName: 'ds',
    task: 'classification',
    model: { name: 'm', version: '1', sha256: 'abc' },
    case: { caseId, imageName: `${caseId}.nii`, aiResult: ai, referenceResult: ref },
    runtime: { provider: 'wasm', inferMs: 1, totalMs: 2 },
    createdAt: '2026-01-01T00:00:00.000Z',
    appVersion: '0.0.0',
  };
}

describe('computeConcordance', () => {
  it('computes 8/10 concordance with Wilson 95% CI approx [0.49, 0.943]', () => {
    const pairs: ConcordancePair[] = [];
    for (let i = 0; i < 8; i++) pairs.push(pair(`c${i}`, 'ICH', 'ICH'));
    pairs.push(pair('c8', 'ICH', 'none'));
    pairs.push(pair('c9', 'none', 'ICH'));

    const r = computeConcordance(pairs);
    expect(r.total).toBe(10);
    expect(r.concordant).toBe(8);
    expect(r.discordant).toBe(2);
    expect(r.rate).toBeCloseTo(0.8, 10);
    expect(r.ciLow).toBeGreaterThan(0.49 - 0.01);
    expect(r.ciLow).toBeLessThan(0.49 + 0.01);
    expect(r.ciHigh).toBeGreaterThan(0.943 - 0.01);
    expect(r.ciHigh).toBeLessThan(0.943 + 0.01);
    expect(r.discordantCaseIds).toEqual(['c8', 'c9']);
  });

  it('all concordant -> rate 1, ciHigh clamped to 1, no discordant ids', () => {
    const pairs = [pair('a', 'x', 'x'), pair('b', 'y', 'y'), pair('c', 'z', 'z')];
    const r = computeConcordance(pairs);
    expect(r.total).toBe(3);
    expect(r.concordant).toBe(3);
    expect(r.discordant).toBe(0);
    expect(r.rate).toBe(1);
    expect(r.ciHigh).toBe(1);
    expect(r.ciLow).toBeGreaterThan(0);
    expect(r.ciLow).toBeLessThanOrEqual(1);
    expect(r.discordantCaseIds).toEqual([]);
  });

  it('empty input -> all zeros', () => {
    const r = computeConcordance([]);
    expect(r).toEqual({
      total: 0,
      concordant: 0,
      discordant: 0,
      rate: 0,
      ciLow: 0,
      ciHigh: 0,
      discordantCaseIds: [],
    });
  });

  it('trims but is case-sensitive when comparing', () => {
    const pairs = [
      pair('trim', '  ICH  ', 'ICH'), // concordant after trim
      pair('caseSensitive', 'ich', 'ICH'), // discordant: differing case
    ];
    const r = computeConcordance(pairs);
    expect(r.concordant).toBe(1);
    expect(r.discordant).toBe(1);
    expect(r.discordantCaseIds).toEqual(['caseSensitive']);
  });
});

describe('concordanceFromRecords', () => {
  it('uses only records with both aiResult and referenceResult defined', () => {
    const records: BenchmarkRecord[] = [
      record('r0', 'ICH', 'ICH'),
      record('r1', 'ICH', 'none'),
      record('r2', undefined, 'ICH'), // skipped: no aiResult
      record('r3', 'ICH', undefined), // skipped: no referenceResult
      record('r4', undefined, undefined), // skipped
    ];
    const r = concordanceFromRecords(records);
    expect(r.total).toBe(2);
    expect(r.concordant).toBe(1);
    expect(r.discordant).toBe(1);
    expect(r.rate).toBeCloseTo(0.5, 10);
    expect(r.discordantCaseIds).toEqual(['r1']);
  });

  it('empty records -> zeros', () => {
    const r = concordanceFromRecords([]);
    expect(r.total).toBe(0);
    expect(r.rate).toBe(0);
    expect(r.ciLow).toBe(0);
    expect(r.ciHigh).toBe(0);
  });
});
