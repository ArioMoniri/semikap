import { describe, expect, it } from 'vitest';
import { summarizeSegmentation, type BenchmarkRecord } from '../src/lib/benchmark/types';
import { recordsToCsv, recordsToJson } from '../src/lib/benchmark/export';
import { serializeNdjson, parseNdjson } from '../src/lib/benchmark/store';
import type { SegMetrics } from '../src/lib/metrics/segmentation';

function seg(label: number, dice: number): SegMetrics {
  return {
    label,
    dice,
    iou: dice / (2 - dice),
    precision: dice,
    recall: dice,
    f1: dice,
    tp: 10,
    fp: 1,
    fn: 1,
    refVoxels: 11,
    predVoxels: 11,
    volumeDiffMl: 0,
    volumetricSimilarity: 1,
    hd95Mm: 2,
    assdMm: 1,
  };
}

function rec(id: string, model: string, version: string, dice: number, inferMs: number): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id,
    profileId: 'p1',
    datasetName: 'ds',
    task: 'segmentation',
    model: { name: model, version, sha256: 'abc' },
    case: { caseId: `case-${id}`, imageName: 'a.nii.gz' },
    runtime: { provider: 'webgpu', inferMs, totalMs: inferMs + 5 },
    segmentation: [seg(1, dice)],
    createdAt: '2026-07-12T00:00:00.000Z',
    appVersion: '0.10.20',
  };
}

describe('summarizeSegmentation', () => {
  it('groups by model+version and ranks by mean Dice', () => {
    const records = [
      rec('1', 'ModelA', '1.0', 0.9, 100),
      rec('2', 'ModelA', '1.0', 0.8, 120),
      rec('3', 'ModelB', '2.0', 0.5, 50),
    ];
    const summary = summarizeSegmentation(records);
    expect(summary).toHaveLength(2);
    expect(summary[0]!.modelName).toBe('ModelA');
    expect(summary[0]!.meanDice).toBeCloseTo(0.85, 6);
    expect(summary[0]!.cases).toBe(2);
    expect(summary[0]!.meanInferMs).toBeCloseTo(110, 6);
    expect(summary[1]!.modelName).toBe('ModelB');
  });
});

describe('recordsToCsv', () => {
  it('emits a header and one row per label', () => {
    const csv = recordsToCsv([rec('1', 'ModelA', '1.0', 0.9, 100)]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('recordId,model,version,caseId,label,dice');
    expect(lines[1]).toContain('ModelA');
    expect(lines[1]).toContain('0.9');
  });

  it('quotes values that contain commas', () => {
    const r = rec('1', 'Model, Inc', '1.0', 0.9, 100);
    const csv = recordsToCsv([r]);
    expect(csv).toContain('"Model, Inc"');
  });
});

describe('NDJSON round-trip', () => {
  it('serializes and parses back, skipping corrupt lines', () => {
    const records = [rec('1', 'A', '1', 0.9, 10), rec('2', 'B', '1', 0.8, 20)];
    const text = serializeNdjson(records) + '\n{bad json}\n\n';
    const back = parseNdjson(text);
    expect(back).toHaveLength(2);
    expect(back[0]!.id).toBe('1');
  });

  it('recordsToJson is valid JSON', () => {
    const json = recordsToJson([rec('1', 'A', '1', 0.9, 10)]);
    expect(JSON.parse(json)).toHaveLength(1);
  });
});
