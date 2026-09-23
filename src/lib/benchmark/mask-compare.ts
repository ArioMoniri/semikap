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

const PRED_RGB = [42, 120, 214]; // categorical slot 1
const GT_RGB = [235, 104, 52]; // categorical slot 2

/**
 * RGBA pixels for one comparison tile: CT in a soft-tissue window
 * (W 400 / L 40), prediction as a translucent fill, ground truth as a
 * 1-px outline (any GT voxel with a 4-neighbour outside the GT).
 */
export function composeTile(
  ct: Float32Array,
  gt: Uint8Array,
  pred: Uint8Array | null,
  width: number,
  height: number,
  window: { level: number; width: number } = { level: 40, width: 400 },
  outline = 1
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const lo = window.level - window.width / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = ((ct[i]! - lo) / window.width) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      let r = v;
      let g = v;
      let b = v;
      if (pred && pred[i]) {
        r = 0.55 * r + 0.45 * PRED_RGB[0]!;
        g = 0.55 * g + 0.45 * PRED_RGB[1]!;
        b = 0.55 * b + 0.45 * PRED_RGB[2]!;
      }
      if (gt[i]) {
        // Edge = a GT pixel within `outline` px (Chebyshev) of a non-GT pixel or the border.
        let edge = false;
        for (let dy = -outline; dy <= outline && !edge; dy++) {
          for (let dx = -outline; dx <= outline; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height || !gt[yy * width + xx]) {
              edge = true;
              break;
            }
          }
        }
        if (edge) [r, g, b] = GT_RGB as [number, number, number];
      }
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}
