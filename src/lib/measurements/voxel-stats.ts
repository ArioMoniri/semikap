/**
 * v0.9.1 — voxel-statistics helpers for ROI measurements.
 *
 * Used by every ROI tool (rectangle, ellipse, circle, freehand,
 * spline, livewire) to compute the mean intensity, standard
 * deviation, and area-in-mm² of the voxels enclosed by the ROI.
 *
 * All functions operate on one slice at a time — the slice is
 * extracted by the wrapper from the loaded volume's voxel buffer
 * indexed by the active crosshair position. Sampling stays cheap
 * because the slice is at most ~1 MB even for a 1024² CT pane.
 */

import type { VolumeRecord } from '../state/store';

export interface SliceStats {
  /** Number of voxels actually enclosed in the ROI (inside-test passed). */
  count: number;
  /** Mean intensity in source-volume units (HU for CT, raw for MR/PT). */
  mean: number;
  /** Sample standard deviation (Bessel-corrected). */
  stddev: number;
  /** Area in source-mm² (count × pixel-area). */
  areaMm2: number;
}

/**
 * Compute stats for the voxels inside a 2D shape on the given axial /
 * coronal / sagittal slice. `inside(x, y)` is a per-voxel predicate the
 * caller supplies (axis-aligned rect: simple bounds check; ellipse:
 * (dx/a)² + (dy/b)² ≤ 1; freehand: even-odd polygon test).
 *
 * `axis` selects which slice to scan from the volume. The scan iterates
 * the bounding box in the slice's natural order and tests each voxel,
 * accumulating count + sum + sumSq for one-pass statistics.
 *
 * Returns 0-stats when the bounding box is fully outside the slice or
 * the inside-test never returns true (e.g. user drew a 1px-wide rect
 * that didn't enclose any voxel centres).
 */
export function statsInsideShape(
  volume: VolumeRecord,
  axis: 'axial' | 'coronal' | 'sagittal',
  sliceIndex: number,
  /** Inclusive bounding box in slice-pixel coords. */
  bbox: { x0: number; y0: number; x1: number; y1: number },
  inside: (x: number, y: number) => boolean
): SliceStats {
  const [X, Y, Z] = volume.meta.dims;
  const [sx, sy, sz] = volume.meta.spacing;
  const data = volume.voxels;

  // Per-axis pixel-area in source-mm² and the in-volume index resolver.
  let pixelAreaMm2 = 0;
  let getIndex: (px: number, py: number) => number;
  let pxLimit = 0;
  let pyLimit = 0;
  if (axis === 'axial') {
    if (sliceIndex < 0 || sliceIndex >= Z) return zeroStats();
    pixelAreaMm2 = sx * sy;
    pxLimit = X;
    pyLimit = Y;
    getIndex = (px, py) => sliceIndex * X * Y + py * X + px;
  } else if (axis === 'coronal') {
    if (sliceIndex < 0 || sliceIndex >= Y) return zeroStats();
    pixelAreaMm2 = sx * sz;
    pxLimit = X;
    pyLimit = Z;
    getIndex = (px, py) => py * X * Y + sliceIndex * X + px;
  } else {
    if (sliceIndex < 0 || sliceIndex >= X) return zeroStats();
    pixelAreaMm2 = sy * sz;
    pxLimit = Y;
    pyLimit = Z;
    getIndex = (px, py) => py * X * Y + px * X + sliceIndex;
  }

  // Clamp the bounding box to the slice's valid range.
  const x0 = Math.max(0, Math.floor(bbox.x0));
  const y0 = Math.max(0, Math.floor(bbox.y0));
  const x1 = Math.min(pxLimit - 1, Math.ceil(bbox.x1));
  const y1 = Math.min(pyLimit - 1, Math.ceil(bbox.y1));
  if (x1 < x0 || y1 < y0) return zeroStats();

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inside(x, y)) continue;
      const v = data[getIndex(x, y)] ?? 0;
      count += 1;
      sum += v;
      sumSq += v * v;
    }
  }
  if (count === 0) return zeroStats();
  const mean = sum / count;
  // Sample variance with Bessel's correction for n>1, population
  // variance for n=1 (avoids divide-by-zero on degenerate ROIs).
  const variance =
    count > 1 ? (sumSq - count * mean * mean) / (count - 1) : sumSq / count - mean * mean;
  const stddev = Math.sqrt(Math.max(0, variance));
  return { count, mean, stddev, areaMm2: count * pixelAreaMm2 };
}

function zeroStats(): SliceStats {
  return { count: 0, mean: 0, stddev: 0, areaMm2: 0 };
}

/**
 * Polygon inside-test (ray casting / even-odd rule). Used by freehand
 * and spline ROIs whose enclosing boundary is a polyline. `polygon`
 * is in slice-pixel coords; the test returns true when the test
 * point is strictly inside the polygon.
 */
export function pointInPolygon(
  x: number,
  y: number,
  polygon: Array<[number, number]>
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Polygon area via the shoelace formula. Returns absolute area in the
 * input coordinate system's units squared. Used by polygon-based ROIs
 * (freehand, spline, livewire) so we can report area without the
 * `count × pixelArea` proxy when the polygon is sub-pixel-precise.
 */
export function polygonArea(polygon: Array<[number, number]>): number {
  if (polygon.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    s += xj * yi - xi * yj;
  }
  return Math.abs(s) / 2;
}

/**
 * Bounding box of a polygon. Used to pre-filter the scan window
 * before the per-pixel inside-test runs.
 */
export function polygonBBox(
  polygon: Array<[number, number]>
): { x0: number; y0: number; x1: number; y1: number } {
  if (polygon.length === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of polygon) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Window/level from a sample of voxels. Used by the Window Level
 * Region tool: drag a rect, sample every voxel inside, then set the
 * NiiVue window to centre = (min+max)/2, width = (max-min). Optional
 * percentile clipping (default 1..99) so a single bright spec or
 * dead-pixel doesn't blow out the contrast.
 */
export function windowLevelFromVoxels(
  voxels: number[],
  pLow = 0.01,
  pHigh = 0.99
): { level: number; width: number } {
  if (voxels.length === 0) return { level: 0, width: 1 };
  const sorted = [...voxels].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * pLow)] ?? sorted[0]!;
  const hi = sorted[Math.floor(sorted.length * pHigh)] ?? sorted[sorted.length - 1]!;
  const width = Math.max(1, hi - lo);
  const level = (hi + lo) / 2;
  return { level, width };
}

/**
 * Sample every voxel inside a 2D shape on a slice into a flat array.
 * Used by the W/L region tool which needs the raw values, not the
 * statistics. Cheaper than allocating a stats object on the hot path.
 */
export function sampleInsideShape(
  volume: VolumeRecord,
  axis: 'axial' | 'coronal' | 'sagittal',
  sliceIndex: number,
  bbox: { x0: number; y0: number; x1: number; y1: number },
  inside: (x: number, y: number) => boolean
): number[] {
  const [X, Y, Z] = volume.meta.dims;
  const data = volume.voxels;
  let getIndex: (px: number, py: number) => number;
  let pxLimit = 0;
  let pyLimit = 0;
  if (axis === 'axial') {
    if (sliceIndex < 0 || sliceIndex >= Z) return [];
    pxLimit = X;
    pyLimit = Y;
    getIndex = (px, py) => sliceIndex * X * Y + py * X + px;
  } else if (axis === 'coronal') {
    if (sliceIndex < 0 || sliceIndex >= Y) return [];
    pxLimit = X;
    pyLimit = Z;
    getIndex = (px, py) => py * X * Y + sliceIndex * X + px;
  } else {
    if (sliceIndex < 0 || sliceIndex >= X) return [];
    pxLimit = Y;
    pyLimit = Z;
    getIndex = (px, py) => py * X * Y + px * X + sliceIndex;
  }
  const x0 = Math.max(0, Math.floor(bbox.x0));
  const y0 = Math.max(0, Math.floor(bbox.y0));
  const x1 = Math.min(pxLimit - 1, Math.ceil(bbox.x1));
  const y1 = Math.min(pyLimit - 1, Math.ceil(bbox.y1));
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inside(x, y)) continue;
      out.push((data[getIndex(x, y)] ?? 0) as number);
    }
  }
  return out;
}

/**
 * Catmull-Rom spline resampler. Given control points in 2D, returns
 * a smooth polyline through them with `samplesPerSegment` interpolated
 * points per control-point pair. Used by the Spline ROI overlay so the
 * boundary is curved rather than polygonal.
 *
 * Using Catmull-Rom with tension=0.5 (centripetal): no overshoot, no
 * loops, smooth even when the user clicks back-to-back points close
 * together. Closes back to point[0] so the resulting polygon is valid
 * for inside-tests + area calculation.
 */
export function catmullRomClosed(
  points: Array<[number, number]>,
  samplesPerSegment = 8
): Array<[number, number]> {
  if (points.length < 3) return points.slice();
  const out: Array<[number, number]> = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % n]!;
    const p3 = points[(i + 2) % n]!;
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}
