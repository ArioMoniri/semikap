/**
 * Segmentation evaluation metrics for radiology benchmarking.
 *
 * All functions are pure and operate on linearized label masks (row-major,
 * x fastest then y then z — the same layout as RunResult.mask). Reference and
 * prediction masks MUST share the same dims; align them first with
 * `../metrics/align`.
 *
 * Overlap metrics (Dice/IoU/precision/recall) are unitless. Surface metrics
 * (HD95/ASSD) and volume difference are spacing-aware and reported in mm / mL.
 *
 * Conventions for degenerate cases (documented, and unit-tested):
 *  - ref empty AND pred empty  → dice = iou = 1 (perfect agreement of absence),
 *    precision = recall = f1 = 1, surface metrics = 0.
 *  - exactly one of ref/pred empty → dice = iou = precision/recall = 0, and
 *    surface metrics = NaN (a distance to an empty surface is undefined).
 */

import { directedDistancesEdt } from './edt';

export interface SegMetrics {
  /** Label these metrics were computed for (foreground label; 0 = background excluded). */
  label: number;
  dice: number;
  /** Jaccard index. */
  iou: number;
  precision: number;
  recall: number;
  /** Harmonic mean of precision/recall; equals Dice for a binary label. */
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  refVoxels: number;
  predVoxels: number;
  /** (pred − ref) volume in mL (cm³); positive = over-segmentation. */
  volumeDiffMl: number;
  /** 1 − |FN − FP| / (2·TP + FP + FN); 1 = identical volumes regardless of overlap. */
  volumetricSimilarity: number;
  /** 95th-percentile symmetric Hausdorff distance in mm; NaN if a surface is empty. */
  hd95Mm: number;
  /** Average symmetric surface distance in mm; NaN if a surface is empty. */
  assdMm: number;
  /**
   * Normalised Surface Dice (Nikolov et al. 2021) at τ = 2 / 5 mm: fraction of
   * both surfaces lying within τ of the other. 1 if both empty, 0 if one is.
   * Absent on records scored before NSD existed or with surface metrics off.
   */
  nsd2Mm?: number;
  nsd5Mm?: number;
  /** Reference / predicted volume in mL (absent on older records). */
  refMl?: number;
  predMl?: number;
}

export interface SegMetricsOptions {
  /** Compute HD95/ASSD (O(surfaceA·surfaceB); skip for very large volumes). Default true. */
  surface?: boolean;
}

const EPS = 1e-9;

/** Binarize a label map to 0/1 for a single foreground label. */
export function binarizeLabel(mask: Uint8Array, label: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] === label ? 1 : 0;
  return out;
}

export interface ConfusionCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** TP/FP/FN/TN of two equal-length binary (0/1) masks (pred vs ref). */
export function confusionCounts(ref: Uint8Array, pred: Uint8Array): ConfusionCounts {
  if (ref.length !== pred.length) {
    throw new Error(`confusionCounts: length mismatch ${ref.length} vs ${pred.length}.`);
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < ref.length; i++) {
    const r = ref[i]!;
    const p = pred[i]!;
    if (p && r) tp++;
    else if (p && !r) fp++;
    else if (!p && r) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

/**
 * Flat indices of surface voxels of a binary mask: a foreground voxel that
 * touches background across a 6-neighbourhood, or lies on the volume boundary.
 */
export function surfaceVoxels(
  bin: Uint8Array,
  dims: readonly [number, number, number]
): number[] {
  const [nx, ny, nz] = dims;
  const out: number[] = [];
  const at = (x: number, y: number, z: number): number => bin[z * nx * ny + y * nx + x]!;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!at(x, y, z)) continue;
        const border =
          x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1 ||
          !at(x - 1, y, z) || !at(x + 1, y, z) ||
          !at(x, y - 1, z) || !at(x, y + 1, z) ||
          !at(x, y, z - 1) || !at(x, y, z + 1);
        if (border) out.push(z * nx * ny + y * nx + x);
      }
    }
  }
  return out;
}

/**
 * Directed nearest-surface distances (mm) from every voxel in `from` to the
 * nearest voxel in `to`. Brute force O(|from|·|to|); callers should run this
 * off the main thread for large volumes.
 */
function directedDistances(
  from: number[],
  to: number[],
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number]
): number[] {
  const [nx, ny] = dims;
  const [sx, sy, sz] = spacing;
  const nxny = nx * ny;
  // Pre-decode `to` into world coords.
  const tx = new Float64Array(to.length);
  const ty = new Float64Array(to.length);
  const tz = new Float64Array(to.length);
  for (let j = 0; j < to.length; j++) {
    const idx = to[j]!;
    const z = Math.floor(idx / nxny);
    const rem = idx - z * nxny;
    const y = Math.floor(rem / nx);
    const x = rem - y * nx;
    tx[j] = x * sx;
    ty[j] = y * sy;
    tz[j] = z * sz;
  }
  const out = new Array<number>(from.length);
  for (let i = 0; i < from.length; i++) {
    const idx = from[i]!;
    const z = Math.floor(idx / nxny);
    const rem = idx - z * nxny;
    const y = Math.floor(rem / nx);
    const x = rem - y * nx;
    const wx = x * sx;
    const wy = y * sy;
    const wz = z * sz;
    let best = Infinity;
    for (let j = 0; j < to.length; j++) {
      const dx = wx - tx[j]!;
      const dy = wy - ty[j]!;
      const dz = wz - tz[j]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    out[i] = Math.sqrt(best);
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export interface SurfaceMetrics {
  hd95Mm: number;
  assdMm: number;
  nsd2Mm: number;
  nsd5Mm: number;
}

/** NSD tolerances (mm) reported in SegMetrics. */
export const NSD_TOLERANCES_MM = [2, 5] as const;

/** HD95 (max of directed 95th percentiles), ASSD (mean of all symmetric distances) and NSD at 2 / 5 mm. */
export function surfaceMetrics(
  ref: Uint8Array,
  pred: Uint8Array,
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number]
): SurfaceMetrics {
  const sa = surfaceVoxels(ref, dims);
  const sb = surfaceVoxels(pred, dims);
  if (sa.length === 0 || sb.length === 0) {
    const nsd = sa.length === sb.length ? 1 : 0;
    return { hd95Mm: NaN, assdMm: NaN, nsd2Mm: nsd, nsd5Mm: nsd };
  }
  // Exact EDT is O(N); brute force only wins for tiny surfaces.
  const dist = sa.length * sb.length > 4_000_000 ? directedDistancesEdt : directedDistances;
  const dAB = dist(sa, sb, dims, spacing);
  const dBA = dist(sb, sa, dims, spacing);
  const sortedAB = [...dAB].sort((a, b) => a - b);
  const sortedBA = [...dBA].sort((a, b) => a - b);
  const hd95 = Math.max(percentile(sortedAB, 95), percentile(sortedBA, 95));
  const all = dAB.concat(dBA);
  const assd = all.reduce((s, v) => s + v, 0) / all.length;
  const nsd = (tau: number) => all.filter((d) => d <= tau + EPS).length / all.length;
  return { hd95Mm: hd95, assdMm: assd, nsd2Mm: nsd(NSD_TOLERANCES_MM[0]), nsd5Mm: nsd(NSD_TOLERANCES_MM[1]) };
}

/**
 * Full segmentation metrics for one foreground label. `ref` and `pred` are
 * label maps of equal length; `dims`/`spacing` describe their shared grid.
 */
export function segmentationMetrics(
  ref: Uint8Array,
  pred: Uint8Array,
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  label: number,
  opts: SegMetricsOptions = {}
): SegMetrics {
  if (ref.length !== pred.length) {
    throw new Error(`segmentationMetrics: length mismatch ${ref.length} vs ${pred.length}.`);
  }
  const refBin = binarizeLabel(ref, label);
  const predBin = binarizeLabel(pred, label);
  const { tp, fp, fn } = confusionCounts(refBin, predBin);
  const refVoxels = tp + fn;
  const predVoxels = tp + fp;

  const bothEmpty = refVoxels === 0 && predVoxels === 0;
  const dice = bothEmpty ? 1 : (2 * tp) / (2 * tp + fp + fn + EPS);
  const iou = bothEmpty ? 1 : tp / (tp + fp + fn + EPS);
  const precision = predVoxels === 0 ? (bothEmpty ? 1 : 0) : tp / (tp + fp);
  const recall = refVoxels === 0 ? (bothEmpty ? 1 : 0) : tp / (tp + fn);
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const voxelMl = (spacing[0] * spacing[1] * spacing[2]) / 1000;
  const volumeDiffMl = (predVoxels - refVoxels) * voxelMl;
  const vsDenom = 2 * tp + fp + fn;
  const volumetricSimilarity = bothEmpty ? 1 : 1 - Math.abs(fn - fp) / (vsDenom + EPS);

  let hd95Mm = NaN;
  let assdMm = NaN;
  let nsd: { nsd2Mm: number; nsd5Mm: number } | null = null;
  if (opts.surface !== false) {
    if (bothEmpty) {
      hd95Mm = 0;
      assdMm = 0;
      nsd = { nsd2Mm: 1, nsd5Mm: 1 };
    } else {
      const s = surfaceMetrics(refBin, predBin, dims, spacing);
      hd95Mm = s.hd95Mm;
      assdMm = s.assdMm;
      nsd = { nsd2Mm: s.nsd2Mm, nsd5Mm: s.nsd5Mm };
    }
  }

  return {
    ...nsd,
    refMl: refVoxels * voxelMl,
    predMl: predVoxels * voxelMl,
    label,
    dice,
    iou,
    precision,
    recall,
    f1,
    tp,
    fp,
    fn,
    refVoxels,
    predVoxels,
    volumeDiffMl,
    volumetricSimilarity,
    hd95Mm,
    assdMm,
  };
}

export interface MultiLabelResult {
  perLabel: SegMetrics[];
  /** Macro-averaged Dice/IoU across labels (ignoring NaN surface metrics). */
  macroDice: number;
  macroIou: number;
}

/** Compute metrics for each foreground label and macro-average Dice/IoU. */
export function multiLabelMetrics(
  ref: Uint8Array,
  pred: Uint8Array,
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  labels: number[],
  opts: SegMetricsOptions = {}
): MultiLabelResult {
  const perLabel = labels.map((l) => segmentationMetrics(ref, pred, dims, spacing, l, opts));
  const macroDice =
    perLabel.length === 0 ? 0 : perLabel.reduce((s, m) => s + m.dice, 0) / perLabel.length;
  const macroIou =
    perLabel.length === 0 ? 0 : perLabel.reduce((s, m) => s + m.iou, 0) / perLabel.length;
  return { perLabel, macroDice, macroIou };
}
