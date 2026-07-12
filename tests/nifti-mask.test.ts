import { describe, expect, it } from 'vitest';
import {
  niftiDataToMask,
  parseNiftiHeader,
  type NiftiHeader,
} from '../src/lib/datasets/nifti-mask';

/**
 * Build a synthetic little-endian single-file NIfTI-1:
 * 352-byte header + 2x2x2 uint8 voxel data.
 */
function buildNifti(labels: number[]): Uint8Array {
  const voxOffset = 352;
  const buf = new Uint8Array(voxOffset + labels.length);
  const view = new DataView(buf.buffer);

  view.setInt16(0, 348, true); // sizeof_hdr
  // dim[0..3]: ndim=3, nx=ny=2, nz=2
  view.setInt16(40, 3, true);
  view.setInt16(42, 2, true);
  view.setInt16(44, 2, true);
  view.setInt16(46, 2, true);
  view.setInt16(70, 2, true); // datatype = uint8
  view.setInt16(72, 8, true); // bitpix
  // pixdim[1..3] = spacing
  view.setFloat32(80, 1.5, true);
  view.setFloat32(84, 1.5, true);
  view.setFloat32(88, 2, true);
  view.setFloat32(108, voxOffset, true); // vox_offset
  // magic 'n+1\0' at 344
  buf[344] = 0x6e;
  buf[345] = 0x2b;
  buf[346] = 0x31;
  buf[347] = 0x00;

  for (let i = 0; i < labels.length; i++) {
    buf[voxOffset + i] = labels[i]!;
  }
  return buf;
}

describe('parseNiftiHeader', () => {
  it('parses dims, spacing, datatype and vox_offset (little-endian)', () => {
    const header = parseNiftiHeader(buildNifti([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(header.dims).toEqual([2, 2, 2]);
    expect(header.spacing[0]).toBeCloseTo(1.5, 6);
    expect(header.spacing[1]).toBeCloseTo(1.5, 6);
    expect(header.spacing[2]).toBeCloseTo(2, 6);
    expect(header.datatype).toBe(2);
    expect(header.bitpix).toBe(8);
    expect(header.voxOffset).toBe(352);
    expect(header.littleEndian).toBe(true);
  });

  it('throws when the "n+1" magic is missing', () => {
    const buf = buildNifti([0, 1, 2, 3, 4, 5, 6, 7]);
    buf[344] = 0x00; // corrupt magic
    expect(() => parseNiftiHeader(buf)).toThrow(/magic/i);
  });

  it('throws when the buffer is too short', () => {
    expect(() => parseNiftiHeader(new Uint8Array(100))).toThrow(/too short/i);
  });
});

describe('niftiDataToMask', () => {
  it('decodes 2x2x2 uint8 labels', () => {
    const labels = [0, 1, 2, 3, 4, 5, 6, 255];
    const buf = buildNifti(labels);
    const header = parseNiftiHeader(buf);
    const mask = niftiDataToMask(buf, header);
    expect(mask.length).toBe(8);
    expect(Array.from(mask)).toEqual(labels);
  });

  it('rounds and clamps float32 values into [0,255]', () => {
    // Manually build a float32 volume of 4 voxels (2x2x1).
    const voxOffset = 352;
    const vals = [0.4, 1.6, -3.0, 999.9];
    const buf = new Uint8Array(voxOffset + vals.length * 4);
    const view = new DataView(buf.buffer);
    view.setInt16(40, 3, true);
    view.setInt16(42, 2, true);
    view.setInt16(44, 2, true);
    view.setInt16(46, 1, true);
    view.setInt16(70, 16, true); // float32
    view.setInt16(72, 32, true);
    view.setFloat32(108, voxOffset, true);
    buf[344] = 0x6e;
    buf[345] = 0x2b;
    buf[346] = 0x31;
    for (let i = 0; i < vals.length; i++) {
      view.setFloat32(voxOffset + i * 4, vals[i]!, true);
    }
    const header: NiftiHeader = parseNiftiHeader(buf);
    const mask = niftiDataToMask(buf, header);
    // 0.4->0, 1.6->2, -3->0 (clamp), 999.9->255 (clamp)
    expect(Array.from(mask)).toEqual([0, 2, 0, 255]);
  });

  it('decodes int16 labels honoring endianness', () => {
    const voxOffset = 352;
    const vals = [0, 5, 17, 42];
    const buf = new Uint8Array(voxOffset + vals.length * 2);
    const view = new DataView(buf.buffer);
    view.setInt16(40, 3, true);
    view.setInt16(42, 2, true);
    view.setInt16(44, 2, true);
    view.setInt16(46, 1, true);
    view.setInt16(70, 4, true); // int16
    view.setInt16(72, 16, true);
    view.setFloat32(108, voxOffset, true);
    buf[344] = 0x6e;
    buf[345] = 0x2b;
    buf[346] = 0x31;
    for (let i = 0; i < vals.length; i++) {
      view.setInt16(voxOffset + i * 2, vals[i]!, true);
    }
    const header = parseNiftiHeader(buf);
    const mask = niftiDataToMask(buf, header);
    expect(Array.from(mask)).toEqual(vals);
  });
});
