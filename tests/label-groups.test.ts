import { describe, expect, it } from 'vitest';
import {
  groupMask,
  scoreLabelGroups,
  LIVER_TUMOUR_GROUPS,
  groupsForModelLabels,
  scoreLabelGroupsMapped,
  canonicalGroupMasks,
} from '../src/lib/metrics/label-groups';

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


describe('model-specific label mapping', () => {
  const btcv = { 0: 'background', 1: 'spleen', 6: 'liver', 7: 'stomach' };
  const nnunet = { 0: 'background', 7: 'tumsomething', 8: 'liver', 9: 'tumor' };

  it('maps BTCV liver label 6 → whole liver; no tumour group', () => {
    const g = groupsForModelLabels(btcv);
    expect(g).toEqual([{ id: 1, name: expect.stringMatching(/liver/), refMembers: [1, 2], predMembers: [6] }]);
  });

  it('nnU-Net: whole liver = liver ∪ tumour labels; tumour = tumour only (not "tumsomething")', () => {
    const g = groupsForModelLabels(nnunet);
    expect(g[0]!.predMembers).toEqual([8, 9]);
    expect(g[1]!.predMembers).toEqual([9]);
  });

  it('scores with different ref/pred label spaces', () => {
    const ref = Uint8Array.from([0, 1, 1, 2]);
    const pred = Uint8Array.from([0, 6, 6, 6]);
    const res = scoreLabelGroupsMapped(ref, pred, [4, 1, 1], [1, 1, 1], groupsForModelLabels(btcv), { surface: false });
    expect(res).toHaveLength(1);
    expect(res[0]!.dice).toBeCloseTo(1, 9);
  });

  it('recognises liver_lesion / hepatic tumour / liver_parenchyma naming variants', () => {
    const g = groupsForModelLabels({ 0: 'background', 1: 'liver_parenchyma', 2: 'liver_lesion' });
    expect(g[0]!.predMembers).toEqual([1, 2]);
    expect(g[1]!.predMembers).toEqual([2]);
    expect(groupsForModelLabels({ 1: 'Liver', 2: 'hepatic tumour' })[1]!.predMembers).toEqual([2]);
    // Unknown "tum*" names stay excluded (nnU-Net's 'tumsomething' lies largely outside the liver).
    expect(groupsForModelLabels({ 7: 'tumsomething', 8: 'liver' })).toHaveLength(1);
  });

  it('throws when a model has no liver label', () => {
    expect(() => groupsForModelLabels({ 0: 'background', 1: 'spleen' })).toThrow(/liver/);
  });
});


describe('canonicalGroupMasks (in-app scoring vs catalogue GT)', () => {
  it('returns binary ref/pred per group in the shared label spaces', () => {
    const ref = Uint8Array.from([0, 1, 2, 2]);
    const pred = Uint8Array.from([0, 8, 9, 8]);
    const g = canonicalGroupMasks(ref, pred, { 0: 'background', 8: 'liver', 9: 'tumor' });
    expect(g.map((x) => x.id)).toEqual([1, 2]);
    expect(Array.from(g[0]!.ref)).toEqual([0, 1, 1, 1]);
    expect(Array.from(g[0]!.pred)).toEqual([0, 1, 1, 1]);
    expect(Array.from(g[1]!.ref)).toEqual([0, 0, 1, 1]);
    expect(Array.from(g[1]!.pred)).toEqual([0, 0, 1, 0]);
  });
});
