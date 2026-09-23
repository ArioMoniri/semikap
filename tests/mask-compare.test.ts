import { describe, expect, it } from 'vitest';
import { pickKeySlice, axialSlice, toRadiological, parseMaskFileName, buildKeySlice } from '../src/lib/benchmark/mask-compare';

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
