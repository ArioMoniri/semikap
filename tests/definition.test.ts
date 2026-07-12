import { describe, expect, it } from 'vitest';
import {
  parseBenchmarkDefinition,
  lockDefinition,
  type BenchmarkDefinition,
} from '../src/lib/benchmark/definition';

function validRaw(): Record<string, unknown> {
  return {
    schema: 'tamias.benchmarkdef.v1',
    id: 'def-1',
    name: 'Liver Vessel Bench',
    version: '1.0.0',
    task: 'segmentation',
    datasetName: 'hepatic-vessels',
    modelHashes: ['abc123', 'def456'],
    metricConfig: { surface: true },
    locked: false,
    createdAt: '2026-07-12T00:00:00.000Z',
  };
}

describe('parseBenchmarkDefinition', () => {
  it('parses a valid definition and copies arrays', () => {
    const raw = validRaw();
    const def = parseBenchmarkDefinition(raw);
    expect(def).toEqual({
      schema: 'tamias.benchmarkdef.v1',
      id: 'def-1',
      name: 'Liver Vessel Bench',
      version: '1.0.0',
      task: 'segmentation',
      datasetName: 'hepatic-vessels',
      modelHashes: ['abc123', 'def456'],
      metricConfig: { surface: true },
      locked: false,
      createdAt: '2026-07-12T00:00:00.000Z',
    });
    // Defensive copy: mutating source array does not affect parsed result.
    (raw['modelHashes'] as string[]).push('zzz');
    expect(def.modelHashes).toEqual(['abc123', 'def456']);
  });

  it('accepts the classification task', () => {
    const raw = validRaw();
    raw['task'] = 'classification';
    expect(parseBenchmarkDefinition(raw).task).toBe('classification');
  });

  it('rejects a non-object', () => {
    expect(() => parseBenchmarkDefinition(null)).toThrow(/must be an object/);
    expect(() => parseBenchmarkDefinition([1, 2])).toThrow(/must be an object/);
  });

  it('rejects a bad schema', () => {
    const raw = validRaw();
    raw['schema'] = 'tamias.benchmarkdef.v2';
    expect(() => parseBenchmarkDefinition(raw)).toThrow(/schema/);
  });

  it('rejects an unknown task', () => {
    const raw = validRaw();
    raw['task'] = 'detection';
    expect(() => parseBenchmarkDefinition(raw)).toThrow(/task/);
  });

  it('rejects empty modelHashes', () => {
    const raw = validRaw();
    raw['modelHashes'] = [];
    expect(() => parseBenchmarkDefinition(raw)).toThrow(/non-empty/);
  });

  it('rejects non-string modelHashes entries', () => {
    const raw = validRaw();
    raw['modelHashes'] = ['ok', 42];
    expect(() => parseBenchmarkDefinition(raw)).toThrow(/modelHashes\[1\]/);
  });

  it('rejects a non-boolean metricConfig.surface', () => {
    const raw = validRaw();
    raw['metricConfig'] = { surface: 'yes' };
    expect(() => parseBenchmarkDefinition(raw)).toThrow(/surface/);
  });

  it('rejects a non-boolean locked', () => {
    const raw = validRaw();
    raw['locked'] = 'false';
    expect(() => parseBenchmarkDefinition(raw)).toThrow(/locked/);
  });

  it('rejects a missing string field', () => {
    const raw = validRaw();
    delete raw['name'];
    expect(() => parseBenchmarkDefinition(raw)).toThrow(/name must be a string/);
  });
});

describe('lockDefinition', () => {
  it('sets locked true without mutating the input', () => {
    const def: BenchmarkDefinition = parseBenchmarkDefinition(validRaw());
    expect(def.locked).toBe(false);
    const locked = lockDefinition(def);
    expect(locked.locked).toBe(true);
    expect(locked).not.toBe(def);
    // Input unchanged.
    expect(def.locked).toBe(false);
  });

  it('preserves all other fields', () => {
    const def = parseBenchmarkDefinition(validRaw());
    const locked = lockDefinition(def);
    expect({ ...locked, locked: false }).toEqual(def);
  });
});
