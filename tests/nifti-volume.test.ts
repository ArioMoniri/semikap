import { describe, expect, it } from 'vitest';
import { niftiDataToVolume, readNiftiVolume } from '../src/lib/datasets/nifti-volume';
import { gzipSync } from 'node:zlib';

/**
 * Build a synthetic little-endian single-file NIfTI-1 intensity volume.
 *
 * @param values   Voxel values (length must equal nx*ny*nz).
 * @param datatype NIfTI datatype code (2=uint8, 4=int16, 8=int32, 16=float32, 512=uint16).
 * @param dims     [nx, ny, nz].
 * @param opts     Optional spacing / scl / origin fields.
 */
function buildNifti(
  values: number[],
  datatype: number,
  dims: [number, number, number],
  opts: {
    spacing?: [number, number, number];
    sclSlope?: number;
    sclInter?: number;
    origin?: [number, number, number];
  } = {},
): Uint8Array {
  const bytesPer =
    datatype === 2 ? 1 : datatype === 4 || datatype === 512 ? 2 : 4;
  const bitpix = bytesPer * 8;
  const voxOffset = 352;
  const buf = new Uint8Array(voxOffset + values.length * bytesPer);
  const view = new DataView(buf.buffer);

  view.setInt16(0, 348, true);
  view.setInt16(40, 3, true); // ndim
  view.setInt16(42, dims[0], true);
  view.setInt16(44, dims[1], true);
  view.setInt16(46, dims[2], true);
  view.setInt16(70, datatype, true);
  view.setInt16(72, bitpix, true);
  const sp = opts.spacing ?? [1, 1, 1];
  view.setFloat32(80, sp[0], true);
  view.setFloat32(84, sp[1], true);
  view.setFloat32(88, sp[2], true);
  view.setFloat32(108, voxOffset, true); // vox_offset
  view.setFloat32(112, opts.sclSlope ?? 0, true); // scl_slope (0 = none)
  view.setFloat32(116, opts.sclInter ?? 0, true); // scl_inter
  const og = opts.origin ?? [0, 0, 0];
  view.setFloat32(268, og[0], true); // qoffset_x
  view.setFloat32(272, og[1], true); // qoffset_y
  view.setFloat32(276, og[2], true); // qoffset_z
  buf[344] = 0x6e;
  buf[345] = 0x2b;
  buf[346] = 0x31;
  buf[347] = 0x00;

  for (let i = 0; i < values.length; i++) {
    const off = voxOffset + i * bytesPer;
    switch (datatype) {
      case 2:
        view.setUint8(off, values[i]!);
        break;
      case 4:
        view.setInt16(off, values[i]!, true);
        break;
      case 512:
        view.setUint16(off, values[i]!, true);
        break;
      case 8:
        view.setInt32(off, values[i]!, true);
        break;
      case 16:
        view.setFloat32(off, values[i]!, true);
        break;
    }
  }
  return buf;
}

describe('niftiDataToVolume', () => {
  it('decodes int16 intensities in native dtype (no clamp to uint8)', () => {
    const vals = [-1000, -400, 0, 300, 1200, 32000, -5, 42];
    const vol = niftiDataToVolume(buildNifti(vals, 4, [2, 2, 2]));
    expect(vol.voxels).toBeInstanceOf(Int16Array);
    expect(Array.from(vol.voxels)).toEqual(vals);
    expect(vol.dims).toEqual([2, 2, 2]);
  });

  it('decodes float32 intensities', () => {
    const vals = [0.5, -3.25, 1000.75, 42.0];
    const vol = niftiDataToVolume(buildNifti(vals, 16, [2, 2, 1]));
    expect(vol.voxels).toBeInstanceOf(Float32Array);
    for (let i = 0; i < vals.length; i++) {
      expect(vol.voxels[i]).toBeCloseTo(vals[i]!, 4);
    }
  });

  it('decodes uint8 and uint16 natively', () => {
    const u8 = niftiDataToVolume(buildNifti([0, 1, 255, 128], 2, [2, 2, 1]));
    expect(u8.voxels).toBeInstanceOf(Uint8Array);
    expect(Array.from(u8.voxels)).toEqual([0, 1, 255, 128]);

    const u16 = niftiDataToVolume(buildNifti([0, 40000, 65535, 100], 512, [2, 2, 1]));
    expect(u16.voxels).toBeInstanceOf(Uint16Array);
    expect(Array.from(u16.voxels)).toEqual([0, 40000, 65535, 100]);
  });

  it('applies scl_slope/scl_inter → Float32 when meaningful', () => {
    // stored int16 raw with slope=2, inter=-1024 (CT-like rescale)
    const raw = [0, 512, 1024, 2048];
    const vol = niftiDataToVolume(
      buildNifti(raw, 4, [2, 2, 1], { sclSlope: 2, sclInter: -1024 }),
    );
    expect(vol.voxels).toBeInstanceOf(Float32Array);
    expect(Array.from(vol.voxels)).toEqual([-1024, 0, 1024, 3072]);
  });

  it('treats slope=0 or identity scaling as no scaling (native dtype)', () => {
    const identity = niftiDataToVolume(
      buildNifti([1, 2, 3, 4], 4, [2, 2, 1], { sclSlope: 1, sclInter: 0 }),
    );
    expect(identity.voxels).toBeInstanceOf(Int16Array);
    const zeroSlope = niftiDataToVolume(
      buildNifti([1, 2, 3, 4], 4, [2, 2, 1], { sclSlope: 0, sclInter: 5 }),
    );
    expect(zeroSlope.voxels).toBeInstanceOf(Int16Array);
    expect(Array.from(zeroSlope.voxels)).toEqual([1, 2, 3, 4]);
  });

  it('reports spacing and origin from the header', () => {
    const vol = niftiDataToVolume(
      buildNifti([0, 0, 0, 0], 2, [2, 2, 1], {
        spacing: [0.75, 0.75, 3],
        origin: [-120.5, 33, 8],
      }),
    );
    expect(vol.spacing[0]).toBeCloseTo(0.75, 5);
    expect(vol.spacing[2]).toBeCloseTo(3, 5);
    expect(vol.origin[0]).toBeCloseTo(-120.5, 4);
    expect(vol.origin[1]).toBeCloseTo(33, 4);
    expect(vol.origin[2]).toBeCloseTo(8, 4);
  });
});

describe('readNiftiVolume', () => {
  it('transparently gunzips a .nii.gz intensity volume', async () => {
    const vals = [-1000, 0, 500, 1500];
    const raw = buildNifti(vals, 4, [2, 2, 1]);
    const gz = new Uint8Array(gzipSync(Buffer.from(raw)));
    const vol = await readNiftiVolume(gz, 'ct.nii.gz');
    expect(vol.voxels).toBeInstanceOf(Int16Array);
    expect(Array.from(vol.voxels)).toEqual(vals);
  });

  it('reads an uncompressed .nii intensity volume', async () => {
    const vals = [1, 2, 3, 4];
    const vol = await readNiftiVolume(buildNifti(vals, 4, [2, 2, 1]), 'ct.nii');
    expect(Array.from(vol.voxels)).toEqual(vals);
  });
});

describe('niftiDataToVolume affine', () => {
  it('returns sform rows when sform_code > 0', () => {
    const buf = buildNifti([0, 0, 0, 0, 0, 0, 0, 0], 2, [2, 2, 2]);
    const v = new DataView(buf.buffer);
    v.setInt16(254, 1, true); // sform_code
    const rows = [
      [-0.8, 0, 0, 100],
      [0, -0.8, 0, 50],
      [0, 0, 2.5, -30],
    ];
    rows.forEach((r, i) => r.forEach((x, j) => v.setFloat32(280 + i * 16 + j * 4, x, true)));
    const vol = niftiDataToVolume(buf);
    expect(vol.srowX).toEqual([expect.closeTo(-0.8, 5), 0, 0, 100]);
    expect(vol.srowY![1]).toBeCloseTo(-0.8, 5);
    expect(vol.srowZ).toEqual([0, 0, 2.5, -30]);
  });

  it('builds the affine from the qform quaternion when only qform_code > 0', () => {
    const buf = buildNifti([0, 0, 0, 0, 0, 0, 0, 0], 2, [2, 2, 2], {
      spacing: [0.5, 0.6, 3],
      origin: [10, 20, 30],
    });
    const v = new DataView(buf.buffer);
    v.setInt16(252, 1, true); // qform_code
    // 180° about z: b=0,c=0,d=1 → x,y flipped (LPS-like)
    v.setFloat32(256, 0, true);
    v.setFloat32(260, 0, true);
    v.setFloat32(264, 1, true);
    v.setFloat32(76, 1, true); // qfac
    const vol = niftiDataToVolume(buf);
    expect(vol.srowX![0]).toBeCloseTo(-0.5, 5);
    expect(vol.srowY![1]).toBeCloseTo(-0.6, 5);
    expect(vol.srowZ![2]).toBeCloseTo(3, 5);
    expect(vol.srowX![3]).toBeCloseTo(10, 5);
  });

  it('leaves the affine undefined when neither form is set', () => {
    const vol = niftiDataToVolume(buildNifti([0], 2, [1, 1, 1]));
    expect(vol.srowX).toBeUndefined();
  });
});
