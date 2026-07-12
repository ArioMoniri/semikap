/**
 * Polygon rasterization for RTSTRUCT contour import.
 *
 * Converts a closed 2D polygon (a DICOM RTSTRUCT contour projected into the
 * pixel grid of a slice) into a binary mask using an even-odd scanline fill.
 * Sampling is done at pixel centers (`y + 0.5`, `x + 0.5`) with a half-open
 * crossing convention, so adjacent polygons that share an edge tile without
 * double-covering or leaving gaps. Concave polygons are handled correctly.
 * Pure and browser-safe: no DOM, canvas, or network access.
 */

/** A closed polygon as an ordered list of `[x, y]` vertices in pixel coordinates. */
export interface Poly {
  points: [number, number][];
}

/**
 * Compute the sorted x-intersections of the polygon's edges with a horizontal
 * scanline at `scanY`, using a half-open `[yTop, yBottom)` crossing rule.
 * @returns Ascending list of x coordinates where edges cross the scanline.
 */
function edgeCrossings(points: [number, number][], scanY: number): number[] {
  const xs: number[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const y1 = a[1];
    const y2 = b[1];
    if (y1 === y2) continue; // horizontal edge contributes no crossing
    // Half-open: include the lower endpoint, exclude the upper endpoint.
    const crosses = (y1 <= scanY && scanY < y2) || (y2 <= scanY && scanY < y1);
    if (!crosses) continue;
    const t = (scanY - y1) / (y2 - y1);
    xs.push(a[0] + t * (b[0] - a[0]));
  }
  xs.sort((p, q) => p - q);
  return xs;
}

/**
 * Fill the mask row `y` for a span `[xa, xb)` in continuous coordinates,
 * setting every pixel whose center `x + 0.5` lies inside the span to `value`.
 * @returns Nothing; mutates `mask` in place.
 */
function fillSpan(
  mask: Uint8Array,
  width: number,
  y: number,
  xa: number,
  xb: number,
  value: number,
): void {
  // Pixel x is covered when xa <= x + 0.5 < xb.
  const xStart = Math.max(0, Math.ceil(xa - 0.5));
  const xEnd = Math.min(width - 1, Math.ceil(xb - 0.5) - 1);
  const row = y * width;
  for (let x = xStart; x <= xEnd; x++) {
    mask[row + x] = value;
  }
}

/**
 * Rasterize a single closed polygon into a `width*height` row-major binary mask
 * (index `y*width + x`) via even-odd scanline fill; polygons with fewer than 3
 * points produce an all-zero mask. `value` (default 1, coerced to a byte) is
 * written to covered pixels.
 * @returns A fresh `Uint8Array` of length `width*height` with covered pixels set.
 */
export function rasterizePolygon(
  poly: Poly,
  width: number,
  height: number,
  value: number = 1,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const v = value & 0xff;
  const points = poly.points;
  if (points.length < 3) return mask;
  for (let y = 0; y < height; y++) {
    const xs = edgeCrossings(points, y + 0.5);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      fillSpan(mask, width, y, xs[i]!, xs[i + 1]!, v);
    }
  }
  return mask;
}

/**
 * Rasterize and OR-composite multiple closed polygons into one binary mask:
 * each polygon is filled even-odd and the union across polygons is taken, so a
 * pixel is set (to 1) when it is covered by any polygon.
 * @returns A fresh `Uint8Array` of length `width*height`; covered pixels are 1.
 */
export function rasterizePolygons(
  polys: Poly[],
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (const poly of polys) {
    const m = rasterizePolygon(poly, width, height, 1);
    for (let i = 0; i < out.length; i++) {
      if (m[i]) out[i] = 1;
    }
  }
  return out;
}
