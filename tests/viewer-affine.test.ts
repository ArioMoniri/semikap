import { describe, expect, it } from 'vitest';
import { affineRows } from '../src/lib/viewer/affine';

describe('affineRows', () => {
  const aff = [
    [-0.78, 0, 0, 206],
    [0, -0.78, 0, 200],
    [0, 0, 2.5, -330],
    [0, 0, 0, 1],
  ];
  it('prefers sform rows', () => {
    expect(affineRows({ srow_x: [1, 0, 0, 1], srow_y: [0, 1, 0, 2], srow_z: [0, 0, 1, 3], affine: aff }).srowX).toEqual([1, 0, 0, 1]);
  });
  it('falls back to the 4×4 affine (NiiVue DICOM loads)', () => {
    const r = affineRows({ affine: aff });
    expect(r.srowX).toEqual([-0.78, 0, 0, 206]);
    expect(r.srowZ).toEqual([0, 0, 2.5, -330]);
  });
  it('treats all-zero srows as absent', () => {
    expect(affineRows({ srow_x: [0, 0, 0, 0], srow_y: [0, 0, 0, 0], srow_z: [0, 0, 0, 0], affine: aff }).srowY).toEqual([0, -0.78, 0, 200]);
  });
  it('returns nothing when neither is usable', () => {
    expect(affineRows({})).toEqual({});
    expect(affineRows(undefined)).toEqual({});
  });
});
