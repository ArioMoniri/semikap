import { describe, expect, it } from 'vitest';
import type { Box } from '../src/lib/datasets/boxes';
import { detectionMetrics, iouBox } from '../src/lib/metrics/detection';

const b = (caseId: string, x: number, y: number, w: number, h: number, score?: number): Box => ({
  caseId,
  x,
  y,
  w,
  h,
  ...(score === undefined ? {} : { score }),
});

describe('iouBox', () => {
  it('two half-overlapping unit boxes → IoU = 1/3', () => {
    // a=[0,1]x[0,1], b=[0.5,1.5]x[0,1]: inter = 0.5*1 = 0.5, union = 1+1-0.5 = 1.5.
    const a = b('c', 0, 0, 1, 1);
    const c = b('c', 0.5, 0, 1, 1);
    expect(iouBox(a, c)).toBeCloseTo(1 / 3, 12);
  });

  it('identical boxes → IoU = 1', () => {
    expect(iouBox(b('c', 2, 3, 4, 5), b('c', 2, 3, 4, 5))).toBe(1);
  });

  it('disjoint boxes → 0', () => {
    expect(iouBox(b('c', 0, 0, 1, 1), b('c', 5, 5, 1, 1))).toBe(0);
  });

  it('edge-touching (no area overlap) → 0', () => {
    expect(iouBox(b('c', 0, 0, 1, 1), b('c', 1, 0, 1, 1))).toBe(0);
  });

  it('3-D IoU uses z & d when both boxes carry them', () => {
    // Two unit cubes half-overlapping along x only: inter = 0.5, union = 1+1-0.5 = 1.5.
    const a: Box = { caseId: 'c', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 };
    const c: Box = { caseId: 'c', x: 0.5, y: 0, z: 0, w: 1, h: 1, d: 1 };
    expect(iouBox(a, c)).toBeCloseTo(1 / 3, 12);
  });

  it('falls back to 2-D when only one box is 3-D', () => {
    const a: Box = { caseId: 'c', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 };
    const c: Box = { caseId: 'c', x: 0, y: 0, w: 1, h: 1 }; // no z/d
    expect(iouBox(a, c)).toBe(1); // identical footprints → 2-D IoU = 1
  });
});

describe('detectionMetrics', () => {
  it('two perfectly-matched boxes over two cases → sensitivity 1, fp 0, ap 1', () => {
    const preds = [b('c1', 0, 0, 10, 10, 0.9), b('c2', 0, 0, 10, 10, 0.8)];
    const refs = [b('c1', 0, 0, 10, 10), b('c2', 0, 0, 10, 10)];
    const r = detectionMetrics(preds, refs, ['c1', 'c2']);
    expect(r.tp).toBe(2);
    expect(r.fp).toBe(0);
    expect(r.fn).toBe(0);
    expect(r.lesionSensitivity).toBe(1);
    expect(r.fpPerImage).toBe(0);
    expect(r.meanAp).toBeCloseTo(1, 12);
    expect(r.localizationErrorMean).toBe(0);
  });

  it('a spurious high-score box → fpPerImage > 0', () => {
    const preds = [
      b('c1', 0, 0, 10, 10, 0.9),
      b('c2', 0, 0, 10, 10, 0.8),
      b('c2', 90, 90, 5, 5, 0.99), // matches nothing
    ];
    const refs = [b('c1', 0, 0, 10, 10), b('c2', 0, 0, 10, 10)];
    const r = detectionMetrics(preds, refs, ['c1', 'c2']);
    expect(r.tp).toBe(2);
    expect(r.fp).toBe(1);
    expect(r.fpPerImage).toBeGreaterThan(0);
    expect(r.fpPerImage).toBe(0.5); // 1 FP over 2 images
    expect(r.lesionSensitivity).toBe(1);
  });

  it('a missed reference → sensitivity 0.5', () => {
    // Two refs in c1, only one predicted.
    const preds = [b('c1', 0, 0, 10, 10, 0.9)];
    const refs = [b('c1', 0, 0, 10, 10), b('c1', 50, 50, 10, 10)];
    const r = detectionMetrics(preds, refs, ['c1']);
    expect(r.tp).toBe(1);
    expect(r.fn).toBe(1);
    expect(r.fp).toBe(0);
    expect(r.lesionSensitivity).toBe(0.5);
  });

  it('localization error = center distance for an offset TP', () => {
    // Pred shifted (+3,+4) but still overlapping enough to match at IoU 0.3.
    const pred = b('c1', 3, 4, 10, 10, 0.9); // IoU with ref = 42 / (100+100-42) ≈ 0.266... too low
    // Use a smaller offset so it still matches.
    const predClose = b('c1', 1, 0, 10, 10, 0.9); // inter=9*10=90, union=110, IoU≈0.818
    const refs = [b('c1', 0, 0, 10, 10)];
    const r = detectionMetrics([predClose], refs, ['c1']);
    expect(r.tp).toBe(1);
    expect(r.localizationErrorMean).toBeCloseTo(1, 12); // centers differ by (1,0)
    void pred;
  });

  it('no references → zeros, not NaN', () => {
    const r = detectionMetrics([b('c1', 0, 0, 10, 10, 0.9)], [], ['c1']);
    expect(r.tp).toBe(0);
    expect(r.fn).toBe(0);
    expect(r.fp).toBe(1);
    expect(r.lesionSensitivity).toBe(0);
    expect(r.meanAp).toBe(0);
    expect(r.localizationErrorMean).toBe(0);
    expect(r.fpPerImage).toBe(1);
  });

  it('FROC is ascending in fpPerImage and spans full recall at threshold 0', () => {
    const preds = [
      b('c1', 0, 0, 10, 10, 0.9),
      b('c2', 0, 0, 10, 10, 0.4),
      b('c1', 80, 80, 5, 5, 0.6), // FP
    ];
    const refs = [b('c1', 0, 0, 10, 10), b('c2', 0, 0, 10, 10)];
    const r = detectionMetrics(preds, refs, ['c1', 'c2']);
    // ascending fpPerImage
    for (let i = 1; i < r.froc.length; i++) {
      expect(r.froc[i]!.fpPerImage).toBeGreaterThanOrEqual(r.froc[i - 1]!.fpPerImage);
    }
    // last point (threshold 0) counts all preds → full sensitivity here (both refs found).
    const last = r.froc[r.froc.length - 1]!;
    expect(last.scoreThreshold).toBe(0);
    expect(last.sensitivity).toBe(1);
    expect(last.fpPerImage).toBe(0.5);
  });

  it('mean AP degrades when a false positive outranks a true positive', () => {
    // c1: FP score 0.9, TP score 0.5. Only one ref.
    const preds = [b('c1', 80, 80, 5, 5, 0.9), b('c1', 0, 0, 10, 10, 0.5)];
    const refs = [b('c1', 0, 0, 10, 10)];
    const r = detectionMetrics(preds, refs, ['c1']);
    expect(r.tp).toBe(1);
    expect(r.fp).toBe(1);
    // PR curve: after FP → prec 0, rec 0; after TP → prec 0.5, rec 1.
    // All-points AP = 0.5.
    expect(r.meanAp).toBeCloseTo(0.5, 12);
  });
});
