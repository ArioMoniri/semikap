/**
 * Minimal NIfTI-1 single-file (.nii) writer for label masks.
 *
 * The NIfTI-1 header is a fixed 348-byte structure followed (after a 4-byte
 * extension flag) by the voxel data. The format spec lives at
 * https://nifti.nimh.nih.gov/nifti-1/documentation/nifti1fields. This writer
 * emits a uint8 mask in canonical [X, Y, Z] order, with the supplied voxel
 * spacing, and identity orientation. That's the right output for a label
 * map produced from a pre-registered input.
 */

import type { Bytes } from '../../types';

const DT_UINT8 = 2;
const HEADER_SIZE = 348;
const EXT_FLAG_SIZE = 4;
const VOX_OFFSET = HEADER_SIZE + EXT_FLAG_SIZE; // 352

export interface NiftiWriteParams {
  mask: Uint8Array;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin?: [number, number, number];
  /**
   * Optional sform rows from the source volume — `srowX = [a,b,c,tx]` and
   * friends — when present we copy them verbatim into the output sform/qform
   * so the mask renders in exactly the same world coordinates as the source
   * (including RAS axis flips). When absent we synthesize spacing*identity +
   * origin, which only matches when the source was already axis-aligned.
   */
  srowX?: [number, number, number, number];
  srowY?: [number, number, number, number];
  srowZ?: [number, number, number, number];
}

export function writeNifti1Uint8({ mask, dims, spacing, origin, srowX, srowY, srowZ }: NiftiWriteParams): Bytes {
  const [nx, ny, nz] = dims;
  const expectedVoxels = nx * ny * nz;
  if (mask.length !== expectedVoxels) {
    throw new Error(
      `Mask length ${mask.length} does not match dims ${nx}*${ny}*${nz} = ${expectedVoxels}.`
    );
  }

  const total = VOX_OFFSET + mask.length;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // sizeof_hdr
  dv.setInt32(0, HEADER_SIZE, true);
  // dim_info @ 39 left zero
  // dim[8]: dim[0] = number of dimensions = 3; dim[1..3] = nx, ny, nz; rest 1
  dv.setInt16(40, 3, true);
  dv.setInt16(42, nx, true);
  dv.setInt16(44, ny, true);
  dv.setInt16(46, nz, true);
  dv.setInt16(48, 1, true);
  dv.setInt16(50, 1, true);
  dv.setInt16(52, 1, true);
  dv.setInt16(54, 1, true);

  // intent_p1/p2/p3 = 0; intent_code = 0 (none)
  // datatype = uint8 (2); bitpix = 8
  dv.setInt16(70, DT_UINT8, true);
  dv.setInt16(72, 8, true);

  // slice_start = 0
  // pixdim[8]: pixdim[0]=qfac (1.0), pixdim[1..3] = spacing, rest 1
  dv.setFloat32(76, 1.0, true);
  dv.setFloat32(80, spacing[0], true);
  dv.setFloat32(84, spacing[1], true);
  dv.setFloat32(88, spacing[2], true);
  dv.setFloat32(92, 1.0, true);
  dv.setFloat32(96, 1.0, true);
  dv.setFloat32(100, 1.0, true);
  dv.setFloat32(104, 1.0, true);

  // vox_offset
  dv.setFloat32(108, VOX_OFFSET, true);
  // scl_slope = 1, scl_inter = 0
  dv.setFloat32(112, 1.0, true);
  dv.setFloat32(116, 0.0, true);
  // slice_end = 0; slice_code = 0
  // xyzt_units: meters/seconds bits — set spatial = mm (2), temporal = sec (8) → 2 | 8 = 10
  dv.setUint8(123, 2 | 8);

  // cal_max/cal_min/slice_duration/toffset = 0

  // descrip[80] @ 148 — 80 bytes of plain ASCII
  writeAscii(u8, 148, 'TAMIAS label mask', 80);
  // aux_file[24] @ 228
  writeAscii(u8, 228, '', 24);

  // qform_code = 1 (scanner_anatomical), sform_code = 1
  dv.setInt16(252, 1, true);
  dv.setInt16(254, 1, true);

  // Quaternion (identity rotation) — qform path is only used by readers that
  // ignore sform; the sform we write below is the canonical affine.
  dv.setFloat32(256, 0.0, true); // quatern_b
  dv.setFloat32(260, 0.0, true); // quatern_c
  dv.setFloat32(264, 0.0, true); // quatern_d
  const ox = srowX?.[3] ?? origin?.[0] ?? 0;
  const oy = srowY?.[3] ?? origin?.[1] ?? 0;
  const oz = srowZ?.[3] ?? origin?.[2] ?? 0;
  dv.setFloat32(268, ox, true); // qoffset_x
  dv.setFloat32(272, oy, true); // qoffset_y
  dv.setFloat32(276, oz, true); // qoffset_z

  // srow_x/y/z. Prefer the source NIfTI's affine when we have it (carries
  // any RAS axis flips and rotations); fall back to spacing*identity + origin.
  const sx = srowX ?? ([spacing[0], 0, 0, ox] as const);
  const sy = srowY ?? ([0, spacing[1], 0, oy] as const);
  const sz = srowZ ?? ([0, 0, spacing[2], oz] as const);
  dv.setFloat32(280, sx[0], true);
  dv.setFloat32(284, sx[1], true);
  dv.setFloat32(288, sx[2], true);
  dv.setFloat32(292, sx[3], true);
  dv.setFloat32(296, sy[0], true);
  dv.setFloat32(300, sy[1], true);
  dv.setFloat32(304, sy[2], true);
  dv.setFloat32(308, sy[3], true);
  dv.setFloat32(312, sz[0], true);
  dv.setFloat32(316, sz[1], true);
  dv.setFloat32(320, sz[2], true);
  dv.setFloat32(324, sz[3], true);

  // intent_name[16] @ 328
  writeAscii(u8, 328, 'label', 16);

  // magic "n+1\0" @ 344
  writeAscii(u8, 344, 'n+1', 4);

  // Extension flag (4 bytes) — zero == no extensions.
  // Already zero by default.

  // Voxel data
  u8.set(mask, VOX_OFFSET);
  return u8 as Bytes;
}

function writeAscii(target: Uint8Array, offset: number, value: string, maxLen: number): void {
  const enc = new TextEncoder();
  const bytes = enc.encode(value);
  const n = Math.min(bytes.length, maxLen - 1);
  target.set(bytes.subarray(0, n), offset);
  // Remaining bytes are zero.
}
