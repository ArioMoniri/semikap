/**
 * Voxel→RAS affine rows from a NiiVue image header. NIfTI files expose
 * srow_x/y/z (sform); NiiVue's DICOM loader only fills `affine` (4×4). Prefer
 * srow when present, else the affine's first three rows.
 */
export type Row4 = [number, number, number, number];

export interface HeaderLike {
  srow_x?: number[];
  srow_y?: number[];
  srow_z?: number[];
  affine?: number[][];
}

const row = (a: number[] | undefined): Row4 | undefined =>
  a && a.length >= 4 && a.slice(0, 4).every(Number.isFinite) ? [a[0]!, a[1]!, a[2]!, a[3]!] : undefined;

const isZero = (r: Row4 | undefined) => !r || r.every((v) => v === 0);

export function affineRows(hdr: HeaderLike | undefined): { srowX?: Row4; srowY?: Row4; srowZ?: Row4 } {
  if (!hdr) return {};
  let x = row(hdr.srow_x);
  let y = row(hdr.srow_y);
  let z = row(hdr.srow_z);
  if ((isZero(x) || isZero(y) || isZero(z)) && Array.isArray(hdr.affine) && hdr.affine.length >= 3) {
    x = row(hdr.affine[0]);
    y = row(hdr.affine[1]);
    z = row(hdr.affine[2]);
  }
  if (isZero(x) || isZero(y) || isZero(z)) return {};
  return { srowX: x, srowY: y, srowZ: z };
}
