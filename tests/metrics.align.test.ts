import { describe, expect, it } from 'vitest';
import { alignToPrediction } from '../src/lib/metrics/align';

describe('alignToPrediction', () => {
  it('returns ref unchanged when grids match', () => {
    const ref = new Uint8Array([0, 1, 1, 0]);
    const pred = new Uint8Array([1, 1, 0, 0]);
    const grid = { dims: [4, 1, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number] };
    const out = alignToPrediction(ref, grid, pred, grid);
    expect(out.ref).toBe(ref);
    expect(out.dims).toEqual([4, 1, 1]);
  });

  it('resamples ref onto a coarser prediction grid (nearest)', () => {
    const ref = new Uint8Array([0, 0, 1, 1]); // 4 voxels
    const refGrid = { dims: [4, 1, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number] };
    const predGrid = { dims: [2, 1, 1] as [number, number, number], spacing: [2, 1, 1] as [number, number, number] };
    const pred = new Uint8Array([0, 1]);
    const out = alignToPrediction(ref, refGrid, pred, predGrid);
    expect(out.ref.length).toBe(2);
    expect(out.dims).toEqual([2, 1, 1]);
    // nearest sampling of centers: dst0→src ~0 (0), dst1→src ~2 (1)
    expect([...out.ref]).toEqual([0, 1]);
  });

  it('throws when a mask length disagrees with its dims', () => {
    const grid = { dims: [4, 1, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number] };
    expect(() => alignToPrediction(new Uint8Array([1, 1]), grid, new Uint8Array([1, 1, 1, 1]), grid)).toThrow();
  });
});
