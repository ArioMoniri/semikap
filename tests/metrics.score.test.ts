import { describe, expect, it } from 'vitest';
import { scoreSegmentation } from '../src/lib/metrics/score';

const grid = {
  dims: [4, 1, 1] as [number, number, number],
  spacing: [1, 1, 1] as [number, number, number],
};

describe('scoreSegmentation', () => {
  it('scores identical masks as perfect (macro Dice 1)', () => {
    const m = new Uint8Array([0, 1, 1, 0]);
    const r = scoreSegmentation({
      refMask: m,
      refGrid: grid,
      predMask: m,
      predGrid: grid,
      labels: [1],
      options: { surface: false },
    });
    expect(r.macroDice).toBeCloseTo(1, 6);
    expect(r.perLabel[0]!.iou).toBeCloseTo(1, 6);
  });

  it('aligns a coarser reference grid before scoring', () => {
    const ref = new Uint8Array([1, 1, 1, 1]); // 4-voxel ref, all label 1
    const pred = new Uint8Array([1, 1]); // 2-voxel prediction, all label 1
    const r = scoreSegmentation({
      refMask: ref,
      refGrid: { dims: [4, 1, 1], spacing: [1, 1, 1] },
      predMask: pred,
      predGrid: { dims: [2, 1, 1], spacing: [2, 1, 1] },
      labels: [1],
      options: { surface: false },
    });
    // reference resamples to [1,1] → perfect overlap with prediction.
    expect(r.macroDice).toBeCloseTo(1, 6);
  });

  it('reports partial overlap correctly', () => {
    const ref = new Uint8Array([1, 1, 0, 0]);
    const pred = new Uint8Array([1, 0, 1, 0]);
    const r = scoreSegmentation({
      refMask: ref,
      refGrid: grid,
      predMask: pred,
      predGrid: grid,
      labels: [1],
      options: { surface: false },
    });
    expect(r.perLabel[0]!.dice).toBeCloseTo(0.5, 6);
  });
});
