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
  const m = [srowX, srowY, srowZ];
  const used = new Set<number>();
  // Assign the strongest voxel axes first so near-oblique grids stay stable.
  const order = [0, 1, 2].sort(
    (a, b) =>
      Math.max(...m.map((r) => Math.abs(r[b]!))) - Math.max(...m.map((r) => Math.abs(r[a]!)))
  );
  const codes: string[] = ['', '', ''];
  for (const j of order) {
    let best = -1;
    let bestAbs = -1;
    for (let w = 0; w < 3; w++) {
      if (used.has(w)) continue;
      const v = Math.abs(m[w]![j]!);
      if (v > bestAbs) {
        bestAbs = v;
        best = w;
      }
    }
    used.add(best);
    codes[j] = m[best]![j]! >= 0 ? LETTER[best]![0] : LETTER[best]![1];
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
