/**
 * Headless NIfTI-1 *intensity* volume decode for batch inference.
 *
 * Unlike {@link readNiftiMask} (which clamps every voxel to a `Uint8` label),
 * this module preserves the source intensities in their native numeric range so
 * a decoded volume can be fed straight into the inference worker exactly like a
 * volume loaded through the interactive viewer. It is deliberately lightweight
 * (no NiiVue / WebGL) so a batch runner can stream one volume at a time.
 *
 * The NIfTI-1 scale header (`scl_slope` / `scl_inter`) is applied when it is
 * meaningful: `value = raw * slope + inter`. When scaling is applied the result
 * is a `Float32Array` (so CT Hounsfield units survive); otherwise the voxels are
 * returned in their stored integer/float type.
 *
 * Pure parsing + `DecompressionStream` for `.nii.gz`. No network, no I/O.
 */

import { parseNiftiHeader, type NiftiHeader } from './nifti-mask';

/** Native typed-array types the inference worker accepts as voxel input. */
export type VolumeVoxels =
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint8Array
  | Float32Array;

/** A decoded NIfTI intensity volume ready for the inference worker. */
export interface NiftiVolume {
  /** Flat voxels in row-major (x fastest) order, native dtype or Float32 if scaled. */
  voxels: VolumeVoxels;
  dims: [number, number, number];
  spacing: [number, number, number];
  /** World-space origin (qoffset_x/y/z); [0,0,0] when absent. */
  origin: [number, number, number];
  /** Voxel→RAS affine rows (sform, else qform); undefined when neither is set. */
  srowX?: [number, number, number, number];
  srowY?: [number, number, number, number];
  srowZ?: [number, number, number, number];
}

type Row4 = [number, number, number, number];

/** sform rows if sform_code > 0, else the qform (quaternion) affine, else undefined. */
function readAffine(buf: Uint8Array, le: boolean): { srowX: Row4; srowY: Row4; srowZ: Row4 } | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sformCode = v.getInt16(254, le);
  const qformCode = v.getInt16(252, le);
  if (sformCode > 0) {
    const row = (o: number): Row4 => [0, 1, 2, 3].map((j) => v.getFloat32(o + j * 4, le)) as Row4;
    return { srowX: row(280), srowY: row(296), srowZ: row(312) };
  }
  if (qformCode > 0) {
    const b = v.getFloat32(256, le);
    const c = v.getFloat32(260, le);
    const d = v.getFloat32(264, le);
    const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)));
    const qfac = v.getFloat32(76, le) < 0 ? -1 : 1;
    const dx = v.getFloat32(80, le);
    const dy = v.getFloat32(84, le);
    const dz = v.getFloat32(88, le) * qfac;
    const R = [
      [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
      [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
      [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - b * b - c * c],
    ];
    const t = [v.getFloat32(268, le), v.getFloat32(272, le), v.getFloat32(276, le)];
    const row = (i: number): Row4 => [R[i]![0]! * dx, R[i]![1]! * dy, R[i]![2]! * dz, t[i]!];
    return { srowX: row(0), srowY: row(1), srowZ: row(2) };
  }
  return null;
}

/** NIfTI-1 datatype codes we know how to decode. */
const DT_UINT8 = 2;
const DT_INT16 = 4;
const DT_INT32 = 8;
const DT_FLOAT32 = 16;
const DT_UINT16 = 512;

/** Read scl_slope (112), scl_inter (116) and qoffset_x/y/z (268/272/276). */
function readScaleAndOrigin(
  buf: Uint8Array,
  littleEndian: boolean,
): { slope: number; inter: number; origin: [number, number, number] } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const slope = view.getFloat32(112, littleEndian);
  const inter = view.getFloat32(116, littleEndian);
  const ox = view.getFloat32(268, littleEndian);
  const oy = view.getFloat32(272, littleEndian);
  const oz = view.getFloat32(276, littleEndian);
  return { slope, inter, origin: [ox, oy, oz] };
}

/** True when the scale header is meaningful (not identity, not degenerate). */
function scaleIsMeaningful(slope: number, inter: number): boolean {
  if (!Number.isFinite(slope) || !Number.isFinite(inter)) return false;
  if (slope === 0) return false; // 0 means "no scaling" per the NIfTI spec
  return slope !== 1 || inter !== 0;
}

/**
 * Decode the voxel data of `buf` into a native typed array of `nx*ny*nz`
 * intensities, honoring datatype and endianness. No scaling is applied here.
 */
function decodeNative(buf: Uint8Array, header: NiftiHeader): VolumeVoxels {
  const [nx, ny, nz] = header.dims;
  const count = nx * ny * nz;
  const offset = Math.trunc(header.voxOffset);
  const le = header.littleEndian;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  switch (header.datatype) {
    case DT_UINT8: {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getUint8(offset + i);
      return out;
    }
    case DT_INT16: {
      const out = new Int16Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getInt16(offset + i * 2, le);
      return out;
    }
    case DT_UINT16: {
      const out = new Uint16Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getUint16(offset + i * 2, le);
      return out;
    }
    case DT_INT32: {
      const out = new Int32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getInt32(offset + i * 4, le);
      return out;
    }
    case DT_FLOAT32: {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getFloat32(offset + i * 4, le);
      return out;
    }
    default:
      throw new Error(`Unsupported NIfTI datatype: ${header.datatype}`);
  }
}

/**
 * Decode a raw (uncompressed) NIfTI-1 buffer into an intensity volume,
 * applying `scl_slope`/`scl_inter` when meaningful.
 */
export function niftiDataToVolume(buf: Uint8Array): NiftiVolume {
  const header = parseNiftiHeader(buf);
  const native = decodeNative(buf, header);
  const { slope, inter, origin } = readScaleAndOrigin(buf, header.littleEndian);

  let voxels: VolumeVoxels = native;
  if (scaleIsMeaningful(slope, inter)) {
    const scaled = new Float32Array(native.length);
    for (let i = 0; i < native.length; i++) scaled[i] = native[i]! * slope + inter;
    voxels = scaled;
  }

  const affine = readAffine(buf, header.littleEndian);
  return {
    voxels,
    dims: header.dims,
    spacing: header.spacing,
    origin,
    ...(affine ?? {}),
  };
}

/**
 * Read a NIfTI intensity volume from `bytes`, transparently gunzipping
 * `.nii.gz` input; resolves to the decoded {@link NiftiVolume}. This is the
 * batch-inference counterpart of {@link readNiftiMask}.
 */
export async function readNiftiVolume(
  bytes: Uint8Array,
  _fileName?: string,
): Promise<NiftiVolume> {
  let raw = bytes;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const arr = await new Response(stream).arrayBuffer();
    raw = new Uint8Array(arr);
  }
  return niftiDataToVolume(raw);
}
