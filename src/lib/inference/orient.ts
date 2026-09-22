/**
 * Reorient a voxel volume to the orientation a model was trained in
 * (`manifest.orientation`), and map the predicted mask back.
 *
 * Orientation codes follow nibabel `aff2axcodes`: letter i is the world
 * direction voxel axis i points toward as its index increases, in RAS world
 * space (R/L, A/P, S/I). 'RAS' = identity NIfTI affine; DICOM series loaded
 * through NiiVue are typically 'LPS'.
 */

type Row = [number, number, number, number];

const WORLD: Record<string, { axis: 0 | 1 | 2; sign: 1 | -1 }> = {
  R: { axis: 0, sign: 1 },
  L: { axis: 0, sign: -1 },
  A: { axis: 1, sign: 1 },
  P: { axis: 1, sign: -1 },
  S: { axis: 2, sign: 1 },
  I: { axis: 2, sign: -1 },
};
const LETTER = [
  ['R', 'L'],
  ['A', 'P'],
  ['S', 'I'],
] as const;

/** Orientation code of a voxel→RAS affine (sform rows). */
export function axisCodes(srowX: Row, srowY: Row, srowZ: Row): string {
  const raw = [srowX, srowY, srowZ];
  // Remove voxel spacing first (unit direction columns), as nibabel does —
  // otherwise the most anisotropic axis wins the assignment on oblique grids.
  const norms = [0, 1, 2].map((j) => Math.hypot(raw[0]![j]!, raw[1]![j]!, raw[2]![j]!) || 1);
  const m = raw.map((r) => [0, 1, 2].map((j) => r[j]! / norms[j]!));
  // Greedy on the globally largest remaining |entry| (nibabel io_orientation
  // picks the dominant (world, voxel) pair each step).
  const usedW = new Set<number>();
  const usedV = new Set<number>();
  const codes: string[] = ['', '', ''];
  for (let step = 0; step < 3; step++) {
    let bw = -1;
    let bv = -1;
    let best = -1;
    for (let w = 0; w < 3; w++) {
      if (usedW.has(w)) continue;
      for (let v = 0; v < 3; v++) {
        if (usedV.has(v)) continue;
        const a = Math.abs(m[w]![v]!);
        if (a > best) {
          best = a;
          bw = w;
          bv = v;
        }
      }
    }
    usedW.add(bw);
    usedV.add(bv);
    codes[bv] = m[bw]![bv]! >= 0 ? LETTER[bw]![0] : LETTER[bw]![1];
  }
  return codes.join('');
}

export interface ReorientPlan {
  /** For each target axis t, the source axis it reads from. */
  src: [number, number, number];
  /** Whether target axis t runs opposite to its source axis. */
  flip: [boolean, boolean, boolean];
}

function parseCodes(code: string): Array<{ axis: 0 | 1 | 2; sign: 1 | -1 }> {
  const up = code.toUpperCase();
  if (up.length !== 3) throw new Error(`Orientation "${code}" must have 3 letters.`);
  const parsed = [...up].map((c) => {
    const w = WORLD[c];
    if (!w) throw new Error(`Orientation "${code}" has invalid letter "${c}".`);
    return w;
  });
  if (new Set(parsed.map((p) => p.axis)).size !== 3) {
    throw new Error(`Orientation "${code}" must use each of R/L, A/P, S/I once.`);
  }
  return parsed;
}

export function planReorientation(from: string, to: string): ReorientPlan {
  const f = parseCodes(from);
  const t = parseCodes(to);
  const src: number[] = [];
  const flip: boolean[] = [];
  for (const target of t) {
    const s = f.findIndex((x) => x.axis === target.axis);
    src.push(s);
    flip.push(f[s]!.sign !== target.sign);
  }
  return { src: src as ReorientPlan['src'], flip: flip as ReorientPlan['flip'] };
}

export function isIdentityPlan(p: ReorientPlan): boolean {
  return p.src[0] === 0 && p.src[1] === 1 && p.src[2] === 2 && !p.flip.some(Boolean);
}

type Arr = Float32Array | Uint8Array;

function remap<T extends Arr>(
  data: T,
  srcDims: [number, number, number],
  plan: ReorientPlan,
  make: (n: number) => T,
  inverse: boolean
): { data: T; dims: [number, number, number] } {
  const tDims = [srcDims[plan.src[0]]!, srcDims[plan.src[1]]!, srcDims[plan.src[2]]!] as [number, number, number];
  // forward: target layout from source; inverse: source layout from target
  const outDims = inverse ? invDims(srcDims, plan) : tDims;
  const out = make(data.length);
  const oldDims: [number, number, number] = inverse ? outDims : srcDims;
  const newDims: [number, number, number] = inverse ? srcDims : tDims;
  const src = [0, 0, 0];
  for (let k = 0; k < newDims[2]; k++) {
    for (let j = 0; j < newDims[1]; j++) {
      for (let i = 0; i < newDims[0]; i++) {
        const t = [i, j, k];
        for (let a = 0; a < 3; a++) {
          const s = plan.src[a]!;
          src[s] = plan.flip[a] ? oldDims[s]! - 1 - t[a]! : t[a]!;
        }
        const oldIdx = src[0]! + oldDims[0] * (src[1]! + oldDims[1] * src[2]!);
        const newIdx = i + newDims[0] * (j + newDims[1] * k);
        if (inverse) out[oldIdx] = data[newIdx]!;
        else out[newIdx] = data[oldIdx]!;
      }
    }
  }
  return { data: out, dims: outDims };
}

function invDims(tDims: [number, number, number], plan: ReorientPlan): [number, number, number] {
  const d: number[] = [0, 0, 0];
  for (let a = 0; a < 3; a++) d[plan.src[a]!] = tDims[a]!;
  return d as [number, number, number];
}

export function applyReorientation(
  data: Float32Array,
  dims: [number, number, number],
  spacing: [number, number, number],
  plan: ReorientPlan
): { data: Float32Array; dims: [number, number, number]; spacing: [number, number, number] } {
  const sp = [spacing[plan.src[0]]!, spacing[plan.src[1]]!, spacing[plan.src[2]]!] as [number, number, number];
  if (isIdentityPlan(plan)) return { data, dims, spacing };
  const r = remap(data, dims, plan, (n) => new Float32Array(n), false);
  return { data: r.data, dims: r.dims, spacing: sp };
}

/** Map a mask in the reoriented layout back to the original voxel layout. */
export function invertReorientation(
  mask: Uint8Array,
  dims: [number, number, number],
  plan: ReorientPlan
): { data: Uint8Array; dims: [number, number, number] } {
  if (isIdentityPlan(plan)) return { data: mask, dims };
  return remap(mask, dims, plan, (n) => new Uint8Array(n), true);
}
