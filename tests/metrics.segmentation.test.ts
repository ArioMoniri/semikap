import { describe, expect, it } from 'vitest';
import {
  binarizeLabel,
  confusionCounts,
  surfaceVoxels,
  surfaceMetrics,
  segmentationMetrics,
  multiLabelMetrics,
} from '../src/lib/metrics/segmentation';

const dims1 = [4, 1, 1] as [number, number, number];
const sp = [1, 1, 1] as [number, number, number];

describe('binarizeLabel', () => {
  it('keeps only the requested label', () => {
    expect([...binarizeLabel(new Uint8Array([0, 1, 2, 1]), 1)]).toEqual([0, 1, 0, 1]);
  });
});

describe('confusionCounts', () => {
  it('counts tp/fp/fn/tn', () => {
    const ref = new Uint8Array([1, 1, 0, 0]);
    const pred = new Uint8Array([1, 0, 1, 0]);
    expect(confusionCounts(ref, pred)).toEqual({ tp: 1, fp: 1, fn: 1, tn: 1 });
  });
  it('throws on length mismatch', () => {
    expect(() => confusionCounts(new Uint8Array([1]), new Uint8Array([1, 0]))).toThrow();
  });
});

describe('segmentationMetrics — overlap', () => {
  it('perfect overlap → dice 1, iou 1', () => {
    const m = new Uint8Array([0, 1, 1, 0]);
    const r = segmentationMetrics(m, m, dims1, sp, 1);
    expect(r.dice).toBeCloseTo(1, 6);
    expect(r.iou).toBeCloseTo(1, 6);
    expect(r.precision).toBeCloseTo(1, 6);
    expect(r.recall).toBeCloseTo(1, 6);
    expect(r.volumeDiffMl).toBeCloseTo(0, 6);
  });

  it('half overlap → dice 0.5, iou 1/3', () => {
    const ref = new Uint8Array([1, 1, 0, 0]);
    const pred = new Uint8Array([1, 0, 1, 0]);
    const r = segmentationMetrics(ref, pred, dims1, sp, 1, { surface: false });
    // tp=1, fp=1, fn=1 → dice = 2/(2+1+1)=0.5, iou = 1/(1+1+1)=1/3
    expect(r.dice).toBeCloseTo(0.5, 6);
    expect(r.iou).toBeCloseTo(1 / 3, 6);
    expect(r.precision).toBeCloseTo(0.5, 6);
    expect(r.recall).toBeCloseTo(0.5, 6);
    expect(r.f1).toBeCloseTo(0.5, 6);
  });

  it('both empty → dice/iou = 1 and surface = 0', () => {
    const z = new Uint8Array([0, 0, 0, 0]);
    const r = segmentationMetrics(z, z, dims1, sp, 1);
    expect(r.dice).toBe(1);
    expect(r.iou).toBe(1);
    expect(r.hd95Mm).toBe(0);
    expect(r.assdMm).toBe(0);
  });

  it('one empty → dice/iou = 0 and surface = NaN', () => {
    const ref = new Uint8Array([1, 1, 0, 0]);
    const pred = new Uint8Array([0, 0, 0, 0]);
    const r = segmentationMetrics(ref, pred, dims1, sp, 1);
    expect(r.dice).toBeCloseTo(0, 6);
    expect(r.iou).toBeCloseTo(0, 6);
    expect(Number.isNaN(r.hd95Mm)).toBe(true);
    expect(Number.isNaN(r.assdMm)).toBe(true);
  });

  it('volume difference is spacing-aware (mL)', () => {
    // pred has 2 extra voxels; spacing 2×2×2 mm = 8 mm³ = 0.008 mL each.
    const ref = new Uint8Array([1, 0, 0, 0]);
    const pred = new Uint8Array([1, 1, 1, 0]);
    const r = segmentationMetrics(ref, pred, dims1, [2, 2, 2], 1, { surface: false });
    expect(r.volumeDiffMl).toBeCloseTo(2 * 0.008, 6);
  });
});

describe('surfaceVoxels + surfaceMetrics', () => {
  it('a solid block: interior voxels are not surface', () => {
    const dims = [3, 3, 3] as [number, number, number];
    const bin = new Uint8Array(27).fill(1);
    // Every voxel touches a boundary except the exact center (index 13).
    const surf = surfaceVoxels(bin, dims);
    expect(surf).not.toContain(13);
    expect(surf.length).toBe(26);
  });

  it('identical masks → HD95 = 0, ASSD = 0', () => {
    const dims = [3, 3, 3] as [number, number, number];
    const bin = new Uint8Array(27).fill(1);
    const s = surfaceMetrics(bin, bin, dims, [1, 1, 1]);
    expect(s.hd95Mm).toBeCloseTo(0, 6);
    expect(s.assdMm).toBeCloseTo(0, 6);
  });

  it('a one-voxel shift produces a positive, spacing-scaled distance', () => {
    const dims = [5, 1, 1] as [number, number, number];
    const a = new Uint8Array([0, 1, 0, 0, 0]);
    const b = new Uint8Array([0, 0, 1, 0, 0]);
    const s = surfaceMetrics(a, b, dims, [2, 1, 1]);
    // single surface voxel each, 1 voxel apart along x with 2mm spacing.
    expect(s.assdMm).toBeCloseTo(2, 6);
    expect(s.hd95Mm).toBeCloseTo(2, 6);
  });
});

describe('multiLabelMetrics', () => {
  it('macro-averages dice across labels', () => {
    const ref = new Uint8Array([1, 1, 2, 2]);
    const pred = new Uint8Array([1, 0, 2, 2]);
    const dims = [4, 1, 1] as [number, number, number];
    const r = multiLabelMetrics(ref, pred, dims, sp, [1, 2], { surface: false });
    // label1: tp1 fn1 → dice 2/3 ; label2: perfect → dice 1
    expect(r.perLabel).toHaveLength(2);
    expect(r.macroDice).toBeCloseTo((2 / 3 + 1) / 2, 6);
  });
});
