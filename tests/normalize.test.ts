import { describe, expect, it } from 'vitest';
import { normalize } from '../src/lib/inference/preprocess';
import { parseManifest } from '../src/lib/inference/manifest';

const base = {
  name: 'm',
  version: '1',
  license: 'x',
  modality: 'CT',
  spacing: [1, 1, 1],
  orientation: 'RAS',
  inference: { type: 'whole' },
  output: { type: 'segmentation', labels: { 0: 'bg', 1: 'liver' } },
};

describe('zscore_volume normalization (nnU-Net ZScoreNormalization)', () => {
  it('standardises with the volume’s own mean and (population) std', () => {
    const d = Float32Array.from([1, 2, 3, 4]);
    normalize(d, { type: 'zscore_volume' });
    const std = Math.sqrt(1.25);
    expect(Array.from(d).map((v) => +v.toFixed(6))).toEqual([-1.5, -0.5, 0.5, 1.5].map((v) => +(v / std).toFixed(6)));
  });

  it('optional clip is applied before the statistics', () => {
    const d = Float32Array.from([-1000, 0, 100, 3000]);
    normalize(d, { type: 'zscore_volume', clip: [-100, 200] });
    const vals = [-100, 0, 100, 200];
    const mean = 50;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / 4);
    expect(d[0]).toBeCloseTo((-100 - mean) / std, 5);
    expect(d[3]).toBeCloseTo((200 - mean) / std, 5);
  });

  it('constant volume does not divide by zero', () => {
    const d = Float32Array.from([5, 5, 5]);
    normalize(d, { type: 'zscore_volume' });
    expect(Array.from(d)).toEqual([0, 0, 0]);
  });

  it('manifest parser accepts zscore_volume with/without clip and rejects a bad clip', () => {
    expect(parseManifest({ ...base, normalization: { type: 'zscore_volume' } }).normalization).toEqual({ type: 'zscore_volume' });
    expect(parseManifest({ ...base, normalization: { type: 'zscore_volume', clip: [-100, 200] } }).normalization).toEqual({
      type: 'zscore_volume',
      clip: [-100, 200],
    });
    expect(() => parseManifest({ ...base, normalization: { type: 'zscore_volume', clip: [5] } })).toThrow();
  });
});
