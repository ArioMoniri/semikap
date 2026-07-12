import { describe, expect, it, vi } from 'vitest';
import {
  runBatch,
  collectRecords,
  summarizeBatch,
  type BatchCaseOutcome,
} from '../src/lib/benchmark/batch-runner';
import type { BatchCase } from '../src/lib/benchmark/batch';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';

const CASES: BatchCase[] = [
  { caseId: 'c1', imageName: 'c1.nii.gz', referenceName: 'c1_seg.nii.gz' },
  { caseId: 'c2', imageName: 'c2.nii.gz' },
  { caseId: 'c3', imageName: 'c3.nii.gz', referenceName: 'c3_seg.nii.gz' },
];

function fakeRecord(caseId: string, model: string): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id: `${model}:${caseId}`,
    profileId: 'p',
    datasetName: 'batch',
    task: 'segmentation',
    model: { name: model, version: 'v', sha256: '' },
    case: { caseId, imageName: `${caseId}.nii.gz` },
    runtime: { provider: 'wasm', inferMs: 1, totalMs: 1 },
    segmentation: [],
    createdAt: '1970-01-01T00:00:00.000Z',
    appVersion: '1',
  };
}

describe('runBatch', () => {
  it('processes cases sequentially and in order', async () => {
    const seen: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const runOne = async (c: BatchCase) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      seen.push(c.caseId);
      concurrent--;
      return { records: [], scored: false };
    };
    await runBatch(CASES, runOne);
    expect(seen).toEqual(['c1', 'c2', 'c3']);
    expect(maxConcurrent).toBe(1); // strictly one at a time
  });

  it('collects records and diff summaries per case', async () => {
    const runOne = async (c: BatchCase) => ({
      records: [fakeRecord(c.caseId, 'A'), fakeRecord(c.caseId, 'B')],
      diff: { both: 10, aOnly: 2, bOnly: 3, agreeFraction: 10 / 15 },
      scored: c.referenceName !== undefined,
    });
    const outcomes = await runBatch(CASES, runOne);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]!.records).toHaveLength(2);
    expect(outcomes[0]!.diff?.both).toBe(10);
    expect(collectRecords(outcomes)).toHaveLength(6);
    const s = summarizeBatch(outcomes);
    expect(s).toEqual({ total: 3, ok: 3, failed: 0, scored: 2 });
  });

  it('isolates a failing case and keeps going', async () => {
    const runOne = async (c: BatchCase) => {
      if (c.caseId === 'c2') throw new Error('decode failed');
      return { records: [fakeRecord(c.caseId, 'A')], scored: false };
    };
    const outcomes = await runBatch(CASES, runOne);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[1]!.error).toBe('decode failed');
    expect(outcomes[1]!.records).toEqual([]);
    expect(outcomes[0]!.error).toBeUndefined();
    expect(summarizeBatch(outcomes)).toEqual({ total: 3, ok: 2, failed: 1, scored: 0 });
  });

  it('reports start/done/error progress for each case', async () => {
    const events: string[] = [];
    const runOne = async (c: BatchCase) => {
      if (c.caseId === 'c3') throw new Error('boom');
      return { records: [], scored: false };
    };
    await runBatch(CASES, runOne, {
      onProgress: (p) => events.push(`${p.caseId}:${p.phase}`),
    });
    expect(events).toEqual([
      'c1:start', 'c1:done',
      'c2:start', 'c2:done',
      'c3:start', 'c3:error',
    ]);
  });

  it('stops before the next case when shouldCancel returns true', async () => {
    const runOne = vi.fn(async () => ({ records: [], scored: false }));
    let done = 0;
    const outcomes: BatchCaseOutcome[] = await runBatch(CASES, async (c, i) => {
      done = i;
      return runOne(c, i);
    }, { shouldCancel: () => done >= 1 });
    // c1 (i=0) runs; before c3 (i=2) shouldCancel sees done>=1 → stop after c2.
    expect(outcomes.length).toBeLessThanOrEqual(2);
    expect(outcomes.map((o) => o.caseId)).not.toContain('c3');
  });
});
