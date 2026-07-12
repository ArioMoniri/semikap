import { describe, expect, it } from 'vitest';
import {
  reconstructSegVolume,
  patientToVoxel,
  rasterizeContours,
} from '../src/lib/datasets/dicom-reconstruct';

describe('reconstructSegVolume (DICOM-SEG)', () => {
  it('reconstructs a bit-packed BINARY segmentation into labels', () => {
    // 2x2 frames, 2 slices. frame0 pixels [1,0,0,1] seg1@z0; frame1 [0,1,1,0] seg2@z1.
    // bits LSB-first across frames → byte0 = bit0|bit3|bit5|bit6 = 1+8+32+64 = 105.
    const { mask, dims } = reconstructSegVolume({
      rows: 2,
      columns: 2,
      depth: 2,
      bitsAllocated: 1,
      pixelData: new Uint8Array([105]),
      frames: [
        { segment: 1, z: 0 },
        { segment: 2, z: 1 },
      ],
    });
    expect(dims).toEqual([2, 2, 2]);
    expect([...mask]).toEqual([1, 0, 0, 1, 0, 2, 2, 0]);
  });

  it('reconstructs an 8-bit FRACTIONAL segmentation (>127 = on)', () => {
    const { mask } = reconstructSegVolume({
      rows: 1,
      columns: 2,
      depth: 1,
      bitsAllocated: 8,
      pixelData: new Uint8Array([200, 50]),
      frames: [{ segment: 3, z: 0 }],
    });
    expect([...mask]).toEqual([3, 0]);
  });
});

describe('patientToVoxel (RTSTRUCT)', () => {
  it('maps patient mm to voxel indices on an axial grid', () => {
    const grid = { origin: [0, 0, 0] as [number, number, number], spacing: [2, 2, 3] as [number, number, number], dims: [10, 10, 5] as [number, number, number] };
    const v = patientToVoxel([4, 6, 9], grid);
    expect(v).toEqual({ x: 2, y: 3, z: 3 });
  });
  it('honours a non-zero origin', () => {
    const grid = { origin: [10, 20, 0] as [number, number, number], spacing: [1, 1, 1] as [number, number, number], dims: [30, 30, 4] as [number, number, number] };
    expect(patientToVoxel([15, 25, 2], grid)).toEqual({ x: 5, y: 5, z: 2 });
  });
});

describe('rasterizeContours (RTSTRUCT)', () => {
  it('fills a square contour on the right slice with the ROI label', () => {
    const dims: [number, number, number] = [5, 5, 2];
    const mask = rasterizeContours(
      [{ z: 1, label: 2, points: [[1, 1], [3, 1], [3, 3], [1, 3]] }],
      dims
    );
    // interior voxel (2,2) at z=1 is labelled; z=0 stays empty.
    expect(mask[1 * 25 + 2 * 5 + 2]).toBe(2);
    expect(mask[0 * 25 + 2 * 5 + 2]).toBe(0);
  });
  it('skips out-of-range slices and degenerate contours', () => {
    const dims: [number, number, number] = [4, 4, 2];
    const mask = rasterizeContours(
      [
        { z: 9, label: 1, points: [[0, 0], [2, 0], [1, 2]] },
        { z: 0, label: 1, points: [[0, 0]] },
      ],
      dims
    );
    expect([...mask].every((v) => v === 0)).toBe(true);
  });
});
