import { describe, expect, it } from 'vitest';
import { largestComponent, fillHoles2D } from '../src/lib/metrics/postprocess';

describe('largestComponent', () => {
  it('keeps the biggest 6-connected blob and drops islands', () => {
    const dims: [number, number, number] = [5, 1, 3];
    const m = new Uint8Array(15);
    // z=0: x0..2 (3 voxels) connected to z=1 x0 → blob of 4; island at z=2 x4
    m[0] = m[1] = m[2] = 1;
    m[5] = 1;
    m[14] = 7;
    const out = largestComponent(m, dims);
    expect(Array.from(out)).toEqual([1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('diagonal neighbours are separate components (6-connectivity)', () => {
    const m = new Uint8Array([1, 0, 0, 1]); // 2x2x1 diagonal
    const out = largestComponent(m, [2, 2, 1]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1);
  });
  it('empty stays empty', () => {
    expect(largestComponent(new Uint8Array(8), [2, 2, 2]).every((v) => v === 0)).toBe(true);
  });
});

describe('fillHoles2D', () => {
  it('fills an enclosed hole per slice but not a notch open to the border', () => {
    const w = 5;
    const m = new Uint8Array(25);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) m[y * w + x] = 1;
    m[2 * w + 2] = 0; // enclosed hole
    const out = fillHoles2D(m, [5, 5, 1]);
    expect(out[2 * w + 2]).toBe(1);
    expect(out[0]).toBe(0);
    const notch = Uint8Array.from(m);
    notch[2 * w + 2] = 0;
    notch[2 * w + 1] = 0;
    notch[2 * w + 0] = 0; // opens to the left border
    expect(fillHoles2D(notch, [5, 5, 1])[2 * w + 2]).toBe(0);
  });
});
