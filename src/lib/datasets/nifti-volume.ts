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

  return {
    voxels,
    dims: header.dims,
    spacing: header.spacing,
    origin,
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
