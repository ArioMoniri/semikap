import { describe, expect, it } from 'vitest';

import {
  rasterizePolygon,
  rasterizePolygons,
  type Poly,
} from '../src/lib/datasets/rasterize';

/** Collect the row-major indices (y*width+x) that are non-zero in `mask`. */
function setPixels(mask: Uint8Array, width: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) out.push([i % width, Math.floor(i / width)]);
  }
  return out;
}

/** Turn an [x,y] list into a Set of "x,y" keys for order-independent comparison. */
function keys(px: Array<[number, number]>): Set<string> {
  return new Set(px.map(([x, y]) => `${x},${y}`));
}

describe('rasterizePolygon', () => {
  it('fills a 2x2 square exactly (interior pixel centers)', () => {
    // Square from (1,1) to (3,3) in continuous coords -> centers at cols/rows 1,2.
    const poly: Poly = {
      points: [
        [1, 1],
        [3, 1],
        [3, 3],
        [1, 3],
      ],
    };
    const mask = rasterizePolygon(poly, 5, 5);
    const expected = keys([
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ]);
    expect(keys(setPixels(mask, 5))).toEqual(expected);
    // Exactly 4 pixels set, all value 1.
    expect(mask.reduce((s, v) => s + v, 0)).toBe(4);
    expect(mask[5 * 1 + 1]).toBe(1);
    expect(mask[5 * 2 + 2]).toBe(1);
    // A corner pixel outside the fill stays 0.
    expect(mask[5 * 0 + 0]).toBe(0);
  });

  it('respects a custom fill value coerced to a byte', () => {
    const poly: Poly = {
      points: [
        [1, 1],
        [3, 1],
        [3, 3],
        [1, 3],
      ],
    };
    const mask = rasterizePolygon(poly, 5, 5, 7);
    expect(mask[5 * 1 + 1]).toBe(7);
    expect(mask[5 * 2 + 2]).toBe(7);
    expect(mask[5 * 0 + 0]).toBe(0);
    // 258 & 0xff === 2, so the value is masked to a byte.
    const masked = rasterizePolygon(poly, 5, 5, 258);
    expect(masked[5 * 1 + 1]).toBe(2);
  });

  it('fills a right triangle as a scanline staircase', () => {
    // Triangle (1,1)-(5,1)-(1,5): right angle at (1,1), hypotenuse x+y=6.
    const poly: Poly = {
      points: [
        [1, 1],
        [5, 1],
        [1, 5],
      ],
    };
    const mask = rasterizePolygon(poly, 6, 6);
    const expected = keys([
      [1, 1],
      [2, 1],
      [3, 1],
      [1, 2],
      [2, 2],
      [1, 3],
    ]);
    expect(keys(setPixels(mask, 6))).toEqual(expected);
  });

  it('fills a concave L-shaped polygon correctly', () => {
    // Concave hexagon: narrow (cols 1-2) at top, widening to cols 1-4 lower.
    const poly: Poly = {
      points: [
        [1, 1],
        [3, 1],
        [3, 3],
        [5, 3],
        [5, 5],
        [1, 5],
      ],
    };
    const mask = rasterizePolygon(poly, 6, 6);
    const expected = keys([
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
      [1, 3],
      [2, 3],
      [3, 3],
      [4, 3],
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
    expect(keys(setPixels(mask, 6))).toEqual(expected);
  });

  it('returns an all-zero mask for an empty polygon', () => {
    const mask = rasterizePolygon({ points: [] }, 4, 4);
    expect(mask.length).toBe(16);
    expect(mask.reduce((s, v) => s + v, 0)).toBe(0);
  });

  it('returns an all-zero mask for a degenerate 2-point polygon', () => {
    const mask = rasterizePolygon(
      {
        points: [
          [0, 0],
          [3, 3],
        ],
      },
      4,
      4,
    );
    expect(mask.reduce((s, v) => s + v, 0)).toBe(0);
  });

  it('clips a polygon extending past the raster bounds', () => {
    // Big square (1,1)-(10,10) into a 4x4 grid: fills cols/rows 1..3.
    const poly: Poly = {
      points: [
        [1, 1],
        [10, 1],
        [10, 10],
        [1, 10],
      ],
    };
    const mask = rasterizePolygon(poly, 4, 4);
    const expected = keys([
      [1, 1],
      [2, 1],
      [3, 1],
      [1, 2],
      [2, 2],
      [3, 2],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(keys(setPixels(mask, 4))).toEqual(expected);
  });
});

describe('rasterizePolygons', () => {
  it('OR-composites two disjoint squares into one union mask', () => {
    const a: Poly = {
      points: [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ],
    };
    const b: Poly = {
      points: [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
      ],
    };
    const mask = rasterizePolygons([a, b], 7, 7);
    const expected = keys([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ]);
    expect(keys(setPixels(mask, 7))).toEqual(expected);
    // Union always uses value 1.
    expect(Math.max(...Array.from(mask))).toBe(1);
  });

  it('unions overlapping polygons without double counting', () => {
    const a: Poly = {
      points: [
        [1, 1],
        [4, 1],
        [4, 4],
        [1, 4],
      ],
    };
    const b: Poly = {
      points: [
        [2, 2],
        [5, 2],
        [5, 5],
        [2, 5],
      ],
    };
    const mask = rasterizePolygons([a, b], 6, 6);
    // Expected is the union of the two 3x3 squares' pixel sets.
    const sq = (ox: number, oy: number): Array<[number, number]> => [
      [ox, oy],
      [ox + 1, oy],
      [ox + 2, oy],
      [ox, oy + 1],
      [ox + 1, oy + 1],
      [ox + 2, oy + 1],
      [ox, oy + 2],
      [ox + 1, oy + 2],
      [ox + 2, oy + 2],
    ];
    const union = keys([...sq(1, 1), ...sq(2, 2)]);
    expect(keys(setPixels(mask, 6))).toEqual(union);
  });

  it('returns an all-zero mask for no polygons', () => {
    const mask = rasterizePolygons([], 3, 3);
    expect(mask.length).toBe(9);
    expect(mask.reduce((s, v) => s + v, 0)).toBe(0);
  });
});
