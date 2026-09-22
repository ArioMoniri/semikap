import { describe, expect, it } from 'vitest';
import { groupMask, scoreLabelGroups, LIVER_TUMOUR_GROUPS } from '../src/lib/metrics/label-groups';

describe('label groups', () => {
  it('groupMask binarises membership', () => {
    expect(Array.from(groupMask(Uint8Array.from([0, 1, 2, 3]), [1, 2]))).toEqual([0, 1, 1, 0]);
  });

  it('whole-liver group scores parenchyma/tumour label confusion as agreement', () => {
    // ref: liver 1 with a tumour 2 inside; pred: calls the tumour liver.
    const ref = Uint8Array.from([0, 1, 1, 2, 2, 0, 0, 0]);
    const pred = Uint8Array.from([0, 1, 1, 1, 1, 0, 0, 0]);
    const res = scoreLabelGroups(ref, pred, [2, 2, 2], [1, 1, 1], LIVER_TUMOUR_GROUPS, { surface: false });
    const whole = res.find((m) => m.label === 1)!;
    const tumour = res.find((m) => m.label === 2)!;
    expect(whole.dice).toBeCloseTo(1, 6);
    expect(tumour.dice).toBeCloseTo(0, 6);
    expect(tumour.refVoxels).toBe(2);
  });

  it('exposes readable group names', () => {
    expect(LIVER_TUMOUR_GROUPS.map((g) => g.id)).toEqual([1, 2]);
    expect(LIVER_TUMOUR_GROUPS[0]!.name).toMatch(/liver/i);
  });
});
