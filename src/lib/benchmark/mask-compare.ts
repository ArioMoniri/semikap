/**
 * Mask comparison across models on the same case: a "key slice" (the axial
 * slice with the most ground-truth foreground) with the CT, the GT (1 liver,
 * 2 tumour) and every model's whole-liver prediction, displayed side by side
 * in radiological convention. Only 2-D slices are kept, so many cases × models
 * fit in memory.
 */

import { applyReorientation, axisCodes, planReorientation } from '../inference/orient';

type Row = [number, number, number, number];
type Vol = Uint8Array | Int16Array | Uint16Array | Int32Array | Float32Array;

export function pickKeySlice(ref: Uint8Array, dims: [number, number, number]): number {
  const [nx, ny, nz] = dims;
  let best = 0;
  let bestN = -1;
  for (let z = 0; z < nz; z++) {
    let n = 0;
    const off = z * nx * ny;
    for (let i = 0; i < nx * ny; i++) if (ref[off + i]) n++;
    if (n > bestN) {
      bestN = n;
      best = z;
    }
  }
  return best;
}

export function axialSlice<T extends Vol>(vol: T, dims: [number, number, number], z: number): T {
  const n = dims[0] * dims[1];
  return vol.slice(z * n, (z + 1) * n) as T;
}

/**
 * Reorient a volume to LPS voxel order: column index → patient Left,
 * row index → Posterior. Rendering the axial slice as-is then gives the
 * radiological view (patient right on the image left, anterior up).
 */
export function toRadiological(
  vol: Uint8Array,
  dims: [number, number, number],
  affine?: { srowX?: Row; srowY?: Row; srowZ?: Row }
): { data: Uint8Array; dims: [number, number, number] } {
  if (!affine?.srowX || !affine.srowY || !affine.srowZ) return { data: vol, dims };
  const plan = planReorientation(axisCodes(affine.srowX, affine.srowY, affine.srowZ), 'LPS');
  // applyReorientation works on Float32; masks are small integers, so a round trip is exact.
  const f = applyReorientation(Float32Array.from(vol), dims, [1, 1, 1], plan);
  return { data: Uint8Array.from(f.data), dims: f.dims };
}

export function toRadiologicalCt(
  ct: Vol,
  dims: [number, number, number],
  affine?: { srowX?: Row; srowY?: Row; srowZ?: Row }
): { data: Float32Array; dims: [number, number, number] } {
  const f = ct instanceof Float32Array ? ct : Float32Array.from(ct as ArrayLike<number>);
  if (!affine?.srowX || !affine.srowY || !affine.srowZ) return { data: f, dims };
  const plan = planReorientation(axisCodes(affine.srowX, affine.srowY, affine.srowZ), 'LPS');
  const r = applyReorientation(f, dims, [1, 1, 1], plan);
  return { data: r.data, dims: r.dims };
}

export function parseMaskFileName(name: string): { modelId: string; caseId: string } | null {
  const m = /^(.+?)__(.+?)\.nii(\.gz)?$/.exec(name.split(/[\\/]/).pop() ?? '');
  return m ? { modelId: m[1]!, caseId: m[2]! } : null;
}

export interface KeySlicePrediction {
  model: string;
  /** 0/1 whole-liver mask on the key slice. */
  mask: Uint8Array;
  /** Dice on this slice only (display aid; volumetric Dice lives in the records). */
  sliceDice: number;
  /** Volumetric whole-liver Dice from the benchmark record, when known. */
  dice?: number;
}

export interface KeySlice {
  caseKey: string;
  z: number;
  width: number;
  height: number;
  /** CT intensities (HU) on the key slice. */
  ct: Float32Array;
  /** Ground truth on the key slice: 1 liver, 2 tumour. */
  gt: Uint8Array;
  preds: KeySlicePrediction[];
}

export interface KeySliceInput {
  caseKey: string;
  ct: Vol;
  reference: Uint8Array;
  dims: [number, number, number];
  /** Volumes must already share the reference grid. */
  predictions: Array<{ model: string; mask: Uint8Array; liverLabels: number[]; dice?: number }>;
  z?: number;
}

export function wholeLiver(mask: Uint8Array, liverLabels: readonly number[]): Uint8Array {
  const set = new Uint8Array(256);
  for (const l of liverLabels) set[l] = 1;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = set[mask[i]!]!;
  return out;
}

export function buildKeySlice(input: KeySliceInput): KeySlice {
  const { dims } = input;
  const z = input.z ?? pickKeySlice(input.reference, dims);
  const gt = axialSlice(input.reference, dims, z);
  const g = gt.map((v) => (v ? 1 : 0));
  const preds = input.predictions.map((p) => {
    const s = wholeLiver(axialSlice(p.mask, dims, z), p.liverLabels);
    let inter = 0;
    let ps = 0;
    let gs = 0;
    for (let i = 0; i < s.length; i++) {
      inter += s[i]! & g[i]!;
      ps += s[i]!;
      gs += g[i]!;
    }
    return { model: p.model, mask: s, sliceDice: ps + gs ? (2 * inter) / (ps + gs) : 1, dice: p.dice };
  });
  const ct = axialSlice(input.ct, dims, z);
  return {
    caseKey: input.caseKey,
    z,
    width: dims[0],
    height: dims[1],
    ct: ct instanceof Float32Array ? ct : Float32Array.from(ct as ArrayLike<number>),
    gt,
    preds,
  };
}
