import { describe, expect, it } from 'vitest';
import { axisCodes, planReorientation, applyReorientation, invertReorientation } from '../src/lib/inference/orient';

type Row = [number, number, number, number];

describe('axisCodes (nibabel aff2axcodes semantics)', () => {
  it('identity affine is RAS', () => {
    expect(axisCodes([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0])).toBe('RAS');
  });
  it('typical DICOM-derived affine (x,y flipped) is LPS', () => {
    expect(axisCodes([-0.7, 0, 0, 0], [0, -0.7, 0, 0], [0, 0, 2.5, 0])).toBe('LPS');
  });
  it('permuted axes', () => {
    // voxel axis0 → world z (S), axis1 → world x (R), axis2 → world y (P)
    expect(axisCodes([0, 1, 0, 0], [0, 0, -1, 0], [1, 0, 0, 0])).toBe('SRP');
  });
});

describe('reorientation', () => {
  // 2x3x4 volume with value = x + 10*y + 100*z
  const dims: [number, number, number] = [2, 3, 4];
  const data = new Float32Array(24);
  for (let z = 0; z < 4; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 2; x++) data[x + 2 * (y + 3 * z)] = x + 10 * y + 100 * z;
  const spacing: [number, number, number] = [0.5, 0.7, 2];

  it('no-op when already in target orientation', () => {
    const plan = planReorientation('RAS', 'RAS');
    const out = applyReorientation(data, dims, spacing, plan);
    expect(out.dims).toEqual(dims);
    expect(Array.from(out.data)).toEqual(Array.from(data));
  });

  it('LPS → RAS flips x and y, keeps z', () => {
    const plan = planReorientation('LPS', 'RAS');
    const out = applyReorientation(data, dims, spacing, plan);
    expect(out.dims).toEqual([2, 3, 4]);
    expect(out.spacing).toEqual([0.5, 0.7, 2]);
    // new (0,0,0) = old (1,2,0)
    expect(out.data[0]).toBe(1 + 20);
    // new (1,2,3) = old (0,0,3)
    expect(out.data[1 + 2 * (2 + 3 * 3)]).toBe(300);
  });

  it('permutation: SRP → RAS moves axes and spacing', () => {
    const plan = planReorientation('SRP', 'RAS');
    const out = applyReorientation(data, dims, spacing, plan);
    // new axis0 (R) = old axis1; new axis1 (A) = old axis2 flipped (P→A); new axis2 (S) = old axis0
    expect(out.dims).toEqual([3, 4, 2]);
    expect(out.spacing).toEqual([0.7, 2, 0.5]);
    // new (i,j,k) = old (x=k, y=i, z=3-j)
    const at = (i: number, j: number, k: number) => out.data[i + 3 * (j + 4 * k)];
    expect(at(2, 0, 1)).toBe(1 + 10 * 2 + 100 * 3);
    expect(at(0, 3, 0)).toBe(0);
  });

  it('invert restores the original layout exactly (masks round-trip)', () => {
    for (const [from, to] of [
      ['LPS', 'RAS'],
      ['SRP', 'RAS'],
      ['RAS', 'LPI'],
      ['PIR', 'LAS'],
    ] as const) {
      const plan = planReorientation(from, to);
      const fwd = applyReorientation(data, dims, spacing, plan);
      const u8 = Uint8Array.from(fwd.data, (v) => v % 251);
      const back = invertReorientation(u8, fwd.dims, plan);
      expect(back.dims).toEqual(dims);
      expect(Array.from(back.data)).toEqual(Array.from(data, (v) => v % 251));
    }
  });

  it('rejects malformed codes', () => {
    expect(() => planReorientation('RRS', 'RAS')).toThrow();
    expect(() => planReorientation('RAS', 'XYZ')).toThrow();
  });
});

export type { Row };
