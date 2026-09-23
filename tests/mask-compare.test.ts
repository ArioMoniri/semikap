import { describe, expect, it } from 'vitest';
import { pickKeySlice, axialSlice, toRadiological, parseMaskFileName, buildKeySlice, composeTile } from '../src/lib/benchmark/mask-compare';

describe('mask comparison helpers', () => {
  const dims: [number, number, number] = [3, 2, 4];
  const ref = new Uint8Array(24);
  // slice z=2 has 3 foreground voxels, z=1 has 1
  ref[0 + 3 * (0 + 2 * 2)] = 1;
  ref[1 + 3 * (0 + 2 * 2)] = 2;
  ref[2 + 3 * (1 + 2 * 2)] = 1;
  ref[0 + 3 * (0 + 2 * 1)] = 1;

  it('pickKeySlice = axial slice with the most foreground', () => {
    expect(pickKeySlice(ref, dims)).toBe(2);
  });

  it('axialSlice extracts x-fastest rows', () => {
    const s = axialSlice(ref, dims, 2);
    expect(Array.from(s)).toEqual([1, 2, 0, 0, 0, 1]);
  });

  it('toRadiological reorients any grid to LPS (x→patient left, y→posterior) so column 0 is patient right', () => {
    // RAS grid: x increases toward patient Right. A voxel at x=2 (most right) must land in column 0.
    const v = new Uint8Array(24);
    v[2 + 3 * (0 + 2 * 0)] = 7;
    const out = toRadiological(v, dims, { srowX: [1, 0, 0, 0], srowY: [0, 1, 0, 0], srowZ: [0, 0, 1, 0] });
    expect(out.dims).toEqual([3, 2, 4]);
    // RAS→LPS flips x and y: (2,0,0) → (0,1,0)
    expect(out.data[0 + 3 * (1 + 2 * 0)]).toBe(7);
  });

  it('parses <model>__<case>.nii.gz names written by the headless runner', () => {
    expect(parseMaskFileName('lms3d_unet__HCC_002.nii.gz')).toEqual({ modelId: 'lms3d_unet', caseId: 'HCC_002' });
    expect(parseMaskFileName('nnunet_liver_lits__liver_22.nii')).toEqual({ modelId: 'nnunet_liver_lits', caseId: 'liver_22' });
    expect(parseMaskFileName('random.nii.gz')).toBeNull();
  });

  it('buildKeySlice returns CT/GT slices and per-model whole-liver masks with Dice', () => {
    const ct = new Int16Array(24).fill(50);
    const pred = new Uint8Array(24);
    pred[0 + 3 * (0 + 2 * 2)] = 6; // BTCV liver label
    pred[1 + 3 * (0 + 2 * 2)] = 6;
    const ks = buildKeySlice({
      caseKey: 'hcc/A',
      ct,
      reference: ref,
      dims,
      predictions: [{ model: 'UNet', mask: pred, liverLabels: [6] }],
    });
    expect(ks.z).toBe(2);
    expect(ks.width).toBe(3);
    expect(ks.height).toBe(2);
    expect(Array.from(ks.gt)).toEqual([1, 2, 0, 0, 0, 1]);
    expect(Array.from(ks.preds[0]!.mask)).toEqual([1, 1, 0, 0, 0, 0]);
    // slice Dice over whole liver: |P∩G|=2, |P|=2, |G|=3 → 0.8
    expect(ks.preds[0]!.sliceDice).toBeCloseTo(0.8, 9);
  });
});

describe('composeTile', () => {
  it('windows CT, fills prediction, outlines GT', () => {
    const w = 4;
    const h = 4;
    const ct = new Float32Array(16).fill(40); // mid-grey at L40
    const gt = new Uint8Array(16);
    for (const i of [5, 6, 9, 10]) gt[i] = 1; // 2x2 block: every GT pixel is an edge
    const pred = new Uint8Array(16);
    pred[0] = 1;
    const px = composeTile(ct, gt, pred, w, h);
    expect(px[3]).toBe(255);
    // pixel 15: plain CT at the window level → mid grey (127.5 → 128)
    expect(px[15 * 4]).toBe(128);
    // pixel 0: blended toward blue
    expect(px[0 * 4 + 2]).toBeGreaterThan(px[0 * 4]!);
    // pixel 5: GT outline orange
    expect([px[20], px[21], px[22]]).toEqual([235, 104, 52]);
  });

  it('draws a thicker outline when asked (legible after downscaling)', () => {
    const w = 8;
    const gt = new Uint8Array(64);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) gt[y * w + x] = 1;
    const ct = new Float32Array(64);
    const thin = composeTile(ct, gt, null, w, w, undefined, 1);
    const thick = composeTile(ct, gt, null, w, w, undefined, 2);
    const orange = (px: Uint8ClampedArray, i: number) => px[i * 4] === 235;
    expect(orange(thin, 3 * w + 3)).toBe(false); // interior, 1 px from the edge
    expect(orange(thick, 3 * w + 3)).toBe(true);
    expect(orange(thick, 4 * w + 4)).toBe(false); // centre stays CT
  });
});
