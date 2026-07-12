/**
 * NIfTI-1 ground-truth label mask import for benchmarking.
 *
 * Pure parsing of NIfTI-1 volumes into a flat `Uint8Array` label mask.
 * Supports raw `.nii` (via {@link parseNiftiHeader} / {@link niftiDataToMask})
 * and gzipped `.nii.gz` (via {@link readNiftiMask}, using `DecompressionStream`).
 */

/** A decoded NIfTI label mask: flat voxel labels plus grid dims and spacing. */
export interface NiftiMask {
  mask: Uint8Array;
  dims: [number, number, number];
  spacing: [number, number, number];
}

/** Parsed subset of a NIfTI-1 header needed to locate and decode voxel data. */
export interface NiftiHeader {
  dims: [number, number, number];
  spacing: [number, number, number];
  datatype: number;
  bitpix: number;
  voxOffset: number;
  littleEndian: boolean;
}

/** NIfTI-1 datatype codes we know how to decode. */
const DT_UINT8 = 2;
const DT_INT16 = 4;
const DT_INT32 = 8;
const DT_FLOAT32 = 16;
const DT_UINT16 = 512;

/**
 * Parse a NIfTI-1 header from `buf`; detects endianness and throws if the
 * `'n+1'` magic at offset 344 is absent.
 */
export function parseNiftiHeader(buf: Uint8Array): NiftiHeader {
  if (buf.length < 348) {
    throw new Error('NIfTI header too short: expected at least 348 bytes');
  }
  // Magic 'n+1\0' at offset 344 identifies a single-file NIfTI-1.
  if (
    buf[344] !== 0x6e /* n */ ||
    buf[345] !== 0x2b /* + */ ||
    buf[346] !== 0x31 /* 1 */
  ) {
    throw new Error('Not a NIfTI-1 file: missing "n+1" magic at offset 344');
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Detect endianness from dim[0] (ndim), which must be in 1..7.
  const ndimLE = view.getInt16(40, true);
  const littleEndian = ndimLE >= 1 && ndimLE <= 7;

  const nx = view.getInt16(42, littleEndian);
  const ny = view.getInt16(44, littleEndian);
  const nz = view.getInt16(46, littleEndian);

  const datatype = view.getInt16(70, littleEndian);
  const bitpix = view.getInt16(72, littleEndian);

  const sx = view.getFloat32(80, littleEndian);
  const sy = view.getFloat32(84, littleEndian);
  const sz = view.getFloat32(88, littleEndian);

  const voxOffset = view.getFloat32(108, littleEndian);

  return {
    dims: [nx, ny, nz],
    spacing: [sx, sy, sz],
    datatype,
    bitpix,
    voxOffset,
    littleEndian,
  };
}

/** Round `v` to nearest integer and clamp into the `[0, 255]` Uint8 range. */
function toLabel(v: number): number {
  const r = Math.round(v);
  if (r < 0) return 0;
  if (r > 255) return 255;
  return r;
}

/**
 * Decode the voxel data of `buf` (sliced at `header.voxOffset`) into a flat
 * `Uint8Array` of `nx*ny*nz` label values, honoring datatype and endianness.
 */
export function niftiDataToMask(buf: Uint8Array, header: NiftiHeader): Uint8Array {
  const [nx, ny, nz] = header.dims;
  const count = nx * ny * nz;
  const out = new Uint8Array(count);
  const offset = Math.trunc(header.voxOffset);
  const le = header.littleEndian;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const read = (i: number): number => {
    switch (header.datatype) {
      case DT_UINT8:
        return view.getUint8(offset + i);
      case DT_INT16:
        return view.getInt16(offset + i * 2, le);
      case DT_INT32:
        return view.getInt32(offset + i * 4, le);
      case DT_FLOAT32:
        return view.getFloat32(offset + i * 4, le);
      case DT_UINT16:
        return view.getUint16(offset + i * 2, le);
      default:
        throw new Error(`Unsupported NIfTI datatype: ${header.datatype}`);
    }
  };

  for (let i = 0; i < count; i++) {
    out[i] = toLabel(read(i));
  }
  return out;
}

/**
 * Read a NIfTI label mask from `bytes`, transparently gunzipping `.nii.gz`
 * input; resolves to the decoded {@link NiftiMask}.
 */
export async function readNiftiMask(
  bytes: Uint8Array,
  _fileName?: string,
): Promise<NiftiMask> {
  let raw = bytes;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    raw = new Uint8Array(buf);
  }
  const header = parseNiftiHeader(raw);
  const mask = niftiDataToMask(raw, header);
  return { mask, dims: header.dims, spacing: header.spacing };
}
