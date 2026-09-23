import { describe, expect, it } from 'vitest';
import { mapSegFramesToGrid, classifySegment, type GridAffine } from '../src/lib/datasets/seg-to-grid';

// 4x3x5 target grid, 2 mm axial slices, axis-aligned. NIfTI/RAS affine as
// NiiVue exposes it for a DICOM series: x → -L (R), y → -P (A) flips.
// voxel (i,j,k) → RAS = (-i*1 + 10, -j*1 + 20, k*2 - 5)
const grid: GridAffine = {
  dims: [4, 3, 5],
  srowX: [-1, 0, 0, 10],
  srowY: [0, -1, 0, 20],
  srowZ: [0, 0, 2, -5],
};

// DICOM frames are in LPS. RAS (x,y,z) = (-Lx, -Ly, z)  ⇒ LPS = (-10 + i, -20 + j, 2k - 5)
function framePos(k: number): [number, number, number] {
  return [-10, -20, 2 * k - 5];
}

describe('mapSegFramesToGrid', () => {
  it('places sparse frames on the CT slice given by ImagePositionPatient, not frame order', () => {
    // Only slices k=1 and k=3 carry segment 1 (sparse SEG, like TCIA SEGs).
    const on = (c: number, r: number) => (c === 2 && r === 1 ? 1 : 0);
    const frames = [1, 3].map((k) => ({
      segment: 1,
      ipp: framePos(k),
      pixels: Uint8Array.from({ length: 12 }, (_, p) => on(p % 4, Math.floor(p / 4))),
    }));
    const out = mapSegFramesToGrid(
      { rows: 3, columns: 4, iop: [1, 0, 0, 0, 1, 0], pixelSpacing: [1, 1], frames },
      grid,
      (s) => s
    );
    expect(out.dims).toEqual([4, 3, 5]);
    const idx = (i: number, j: number, k: number) => i + 4 * (j + 3 * k);
    expect(out.mask[idx(2, 1, 1)]).toBe(1);
    expect(out.mask[idx(2, 1, 3)]).toBe(1);
    expect(out.mask[idx(2, 1, 0)]).toBe(0);
    expect(out.mask[idx(2, 1, 2)]).toBe(0);
    expect(out.mask.reduce((a, b) => a + b, 0)).toBe(2);
    expect(out.outOfGridFrames).toBe(0);
  });

  it('applies the label map with priority (tumor overrides liver), drops unmapped segments', () => {
    const full = new Uint8Array(12).fill(1);
    const frames = [
      { segment: 1, ipp: framePos(0), pixels: full }, // liver
      { segment: 2, ipp: framePos(0), pixels: Uint8Array.from({ length: 12 }, (_, p) => (p === 0 ? 1 : 0)) }, // tumor
      { segment: 3, ipp: framePos(0), pixels: full }, // vessel → dropped
    ];
    const map = (s: number) => (s === 1 ? 1 : s === 2 ? 2 : 0);
    const out = mapSegFramesToGrid(
      { rows: 3, columns: 4, iop: [1, 0, 0, 0, 1, 0], pixelSpacing: [1, 1], frames },
      grid,
      map
    );
    expect(out.mask[0]).toBe(2);
    expect(out.mask[1]).toBe(1);
    expect(out.mask[12]).toBe(0);
  });

  it('counts frames that fall outside the target grid (geometry mismatch guard)', () => {
    const out = mapSegFramesToGrid(
      {
        rows: 3,
        columns: 4,
        iop: [1, 0, 0, 0, 1, 0],
        pixelSpacing: [1, 1],
        frames: [{ segment: 1, ipp: [-10, -20, 500], pixels: new Uint8Array(12).fill(1) }],
      },
      grid,
      (s) => s
    );
    expect(out.outOfGridFrames).toBe(1);
    expect(out.mask.every((v) => v === 0)).toBe(true);
  });
});

describe('classifySegment', () => {
  it('maps TCIA / MSD style descriptions to liver=1 / tumor=2 / other=0', () => {
    expect(classifySegment('Liver')).toBe(1);
    expect(classifySegment('liver parenchyma')).toBe(1);
    expect(classifySegment('Mass')).toBe(2);
    expect(classifySegment('Tumor')).toBe(2);
    expect(classifySegment('Neoplasm, Primary')).toBe(2);
    expect(classifySegment('Lesion')).toBe(2);
    expect(classifySegment('Portal vein')).toBe(0);
    expect(classifySegment('Aorta')).toBe(0);
    expect(classifySegment('Blood vessel')).toBe(0);
  });
  it('is word-anchored and documents tumour-thrombus precedence', () => {
    expect(classifySegment('Portal vein tumour thrombus')).toBe(2);
    expect(classifySegment('HCC')).toBe(2);
    expect(classifySegment('Masseter')).toBe(0);
    expect(classifySegment('Deliverable')).toBe(0);
    expect(classifySegment('Hepatic arteries')).toBe(0);
  });
});
