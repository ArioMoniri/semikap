import { describe, expect, it } from 'vitest';
import {
  recordCompleteness,
  summarizeCompleteness,
} from '../src/lib/benchmark/completeness';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';

/** Build a minimal BenchmarkRecord, overriding only the fields a test cares about. */
function makeRecord(overrides: Partial<BenchmarkRecord> = {}): BenchmarkRecord {
  const base: BenchmarkRecord = {
    schema: 'tamias.benchmark.v1',
    id: 'rec-1',
    profileId: 'prof-1',
    datasetName: 'ds',
    task: 'segmentation',
    model: { name: 'm', version: '1', sha256: 'abc' },
    case: { caseId: 'c1', imageName: 'img.nii.gz' },
    runtime: { provider: 'wasm', inferMs: 10, totalMs: 20 },
    createdAt: '2026-01-01T00:00:00Z',
    appVersion: '0.10.15',
  };
  return { ...base, ...overrides };
}

describe('recordCompleteness', () => {
  it('flags all three present (segmentation + meta + referenceName)', () => {
    const r = makeRecord({
      case: {
        caseId: 'c-all',
        imageName: 'img.nii.gz',
        referenceName: 'ref.nii.gz',
        meta: { modality: 'CT' },
      },
      segmentation: [
        {
          label: 1,
          dice: 0.9,
          iou: 0.8,
          precision: 0.9,
          recall: 0.9,
          f1: 0.9,
          tp: 100,
          fp: 10,
          fn: 10,
          refVoxels: 110,
          predVoxels: 110,
          volumeDiffMl: 0,
          volumetricSimilarity: 1,
          hd95Mm: 2,
          assdMm: 1,
        },
      ],
    });
    expect(recordCompleteness(r)).toEqual({
      caseId: 'c-all',
      hasAiResult: true,
      hasDicomMeta: true,
      hasReference: true,
      complete: true,
    });
  });

  it('treats an empty segmentation array as no AI result', () => {
    const r = makeRecord({
      case: {
        caseId: 'c-empty-seg',
        imageName: 'img.nii.gz',
        referenceName: 'ref.nii.gz',
        meta: { modality: 'MR' },
      },
      segmentation: [],
    });
    const out = recordCompleteness(r);
    expect(out.hasAiResult).toBe(false);
    expect(out.complete).toBe(false);
  });

  it('detects AI result via classification', () => {
    const r = makeRecord({
      task: 'classification',
      case: { caseId: 'c-cls', imageName: 'img.png' },
      classification: {} as BenchmarkRecord['classification'],
    });
    expect(recordCompleteness(r).hasAiResult).toBe(true);
  });

  it('detects AI result and reference via string result fields', () => {
    const r = makeRecord({
      case: {
        caseId: 'c-str',
        imageName: 'img.png',
        resultIndicator: 'ICH',
        aiResult: 'positive',
        referenceResult: 'positive',
      },
    });
    const out = recordCompleteness(r);
    expect(out.hasAiResult).toBe(true);
    expect(out.hasReference).toBe(true);
    expect(out.hasDicomMeta).toBe(false);
    expect(out.complete).toBe(false);
  });

  it('flags a bare record as incomplete on all axes', () => {
    const r = makeRecord({ case: { caseId: 'c-bare', imageName: 'img.png' } });
    expect(recordCompleteness(r)).toEqual({
      caseId: 'c-bare',
      hasAiResult: false,
      hasDicomMeta: false,
      hasReference: false,
      complete: false,
    });
  });
});

describe('summarizeCompleteness', () => {
  it('returns fraction 0 for an empty list', () => {
    const { rows, summary } = summarizeCompleteness([]);
    expect(rows).toEqual([]);
    expect(summary).toEqual({
      total: 0,
      withAiResult: 0,
      withDicomMeta: 0,
      withReference: 0,
      complete: 0,
      completeFraction: 0,
    });
  });

  it('counts each axis and complete fraction across mixed records', () => {
    const complete = makeRecord({
      case: {
        caseId: 'c-complete',
        imageName: 'a.png',
        referenceName: 'ref.nii.gz',
        meta: { modality: 'CT' },
        aiResult: 'x',
      },
    });
    const aiAndMetaOnly = makeRecord({
      case: {
        caseId: 'c-ai-meta',
        imageName: 'b.png',
        meta: { modality: 'MR' },
        aiResult: 'y',
      },
    });
    const refOnly = makeRecord({
      case: { caseId: 'c-ref', imageName: 'c.png', referenceResult: 'z' },
    });
    const bare = makeRecord({ case: { caseId: 'c-bare', imageName: 'd.png' } });

    const { rows, summary } = summarizeCompleteness([
      complete,
      aiAndMetaOnly,
      refOnly,
      bare,
    ]);

    expect(rows).toHaveLength(4);
    expect(summary).toEqual({
      total: 4,
      withAiResult: 2,
      withDicomMeta: 2,
      withReference: 2,
      complete: 1,
      completeFraction: 0.25,
    });
  });
});
