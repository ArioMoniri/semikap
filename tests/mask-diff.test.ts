import { describe, it, expect } from 'vitest';
import { diffVolume, maxDisagreementSlice } from '../src/lib/metrics/mask-diff';

describe('diffVolume', () => {
  it('labels both/A-only/B-only/neither for two 4x1x1 masks (default any non-zero)', () => {
    // voxel 0: both, voxel 1: A only, voxel 2: B only, voxel 3: neither
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array([1, 0, 1, 0]);
    const r = diffVolume(a, b);
    expect(Array.from(r.diff)).toEqual([1, 2, 3, 0]);
    expect(r.both).toBe(1);
    expect(r.aOnly).toBe(1);
    expect(r.bOnly).toBe(1);
    // both / (both + aOnly + bOnly) = 1/3
    expect(r.agreeFraction).toBeCloseTo(1 / 3, 12);
  });

  it('respects an explicit foreground label', () => {
    // label 2 is foreground; label 1 and 0 are background
    const a = new Uint8Array([2, 2, 1, 0]);
    const b = new Uint8Array([2, 0, 2, 2]);
    const r = diffVolume(a, b, 2);
    // v0 both(2&2), v1 A-only(2 vs 0), v2 B-only(1->bg vs 2), v3 B-only(0 vs 2)
    expect(Array.from(r.diff)).toEqual([1, 2, 3, 3]);
    expect(r.both).toBe(1);
    expect(r.aOnly).toBe(1);
    expect(r.bOnly).toBe(2);
    expect(r.agreeFraction).toBeCloseTo(1 / 4, 12);
  });

  it('identical masks -> agreeFraction 1 and only values 0/1', () => {
    const a = new Uint8Array([1, 0, 1, 1, 0]);
    const b = new Uint8Array([1, 0, 1, 1, 0]);
    const r = diffVolume(a, b);
    expect(r.aOnly).toBe(0);
    expect(r.bOnly).toBe(0);
    expect(r.both).toBe(3);
    expect(r.agreeFraction).toBe(1);
    expect(Array.from(r.diff).every((v) => v === 0 || v === 1)).toBe(true);
    expect(Array.from(r.diff)).toEqual([1, 0, 1, 1, 0]);
  });

  it('disjoint foregrounds -> agreeFraction 0', () => {
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array([0, 0, 1, 1]);
    const r = diffVolume(a, b);
    expect(r.both).toBe(0);
    expect(r.aOnly).toBe(2);
    expect(r.bOnly).toBe(2);
    expect(r.agreeFraction).toBe(0);
    expect(Array.from(r.diff)).toEqual([2, 2, 3, 3]);
  });

  it('empty union -> agreeFraction 1 (no disagreement, no agreement)', () => {
    const a = new Uint8Array([0, 0, 0]);
    const b = new Uint8Array([0, 0, 0]);
    const r = diffVolume(a, b);
    expect(r.both).toBe(0);
    expect(r.aOnly).toBe(0);
    expect(r.bOnly).toBe(0);
    expect(r.agreeFraction).toBe(1);
    expect(Array.from(r.diff)).toEqual([0, 0, 0]);
  });

  it('throws on length mismatch', () => {
    const a = new Uint8Array([1, 0, 1]);
    const b = new Uint8Array([1, 0]);
    expect(() => diffVolume(a, b)).toThrow(RangeError);
  });
});

describe('maxDisagreementSlice', () => {
  it('picks the slice with the most disagreement voxels (values 2/3)', () => {
    // dims 2x1x3 -> 2 voxels per slice, 3 slices
    // slice 0: [1,1] -> 0 disagreement
    // slice 1: [2,0] -> 1 disagreement
    // slice 2: [2,3] -> 2 disagreement (winner)
    const diff = new Uint8Array([1, 1, 2, 0, 2, 3]);
    const s = maxDisagreementSlice(diff, [2, 1, 3]);
    expect(s.z).toBe(2);
    expect(s.width).toBe(2);
    expect(s.height).toBe(1);
    expect(s.disagreeCount).toBe(2);
    expect(Array.from(s.pixels)).toEqual([2, 3]);
  });

  it('ties resolve to the lowest z', () => {
    // dims 2x1x3; slices 0 and 1 both have 1 disagreement, slice 2 has none
    const diff = new Uint8Array([2, 0, 3, 0, 0, 0]);
    const s = maxDisagreementSlice(diff, [2, 1, 3]);
    expect(s.z).toBe(0);
    expect(s.disagreeCount).toBe(1);
    expect(Array.from(s.pixels)).toEqual([2, 0]);
  });

  it('no disagreement -> returns the middle slice', () => {
    // dims 1x1x5, all agreement/background -> middle index floor(5/2) = 2
    const diff = new Uint8Array([1, 1, 0, 1, 0]);
    const s = maxDisagreementSlice(diff, [1, 1, 5]);
    expect(s.z).toBe(2);
    expect(s.disagreeCount).toBe(0);
    expect(Array.from(s.pixels)).toEqual([0]);
  });

  it('throws when dims do not match the volume length', () => {
    const diff = new Uint8Array([1, 2, 3]);
    expect(() => maxDisagreementSlice(diff, [2, 1, 3])).toThrow(RangeError);
  });
});
