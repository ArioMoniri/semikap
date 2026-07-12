import { describe, expect, it } from 'vitest';
import {
  rocCurve,
  prCurve,
  calibrationCurve,
  confusionCounts,
  type Pt,
} from '../src/lib/plots/curves';

const hasPoint = (pts: Pt[], x: number, y: number): boolean =>
  pts.some((p) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);

describe('rocCurve', () => {
  it('perfect separation gives auc 1 and passes through (0,1)', () => {
    const labels = [0, 0, 1, 1];
    const scores = [0.1, 0.2, 0.8, 0.9];
    const { points, auc } = rocCurve(labels, scores);
    expect(auc).toBeCloseTo(1, 10);
    // endpoints always present
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 1, y: 1 });
    // perfect classifier reaches top-left corner
    expect(hasPoint(points, 0, 1)).toBe(true);
    // monotonic non-decreasing in x and y
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.x).toBeGreaterThanOrEqual(points[i - 1]!.x);
      expect(points[i]!.y).toBeGreaterThanOrEqual(points[i - 1]!.y);
    }
  });

  it('intermediate thresholds produce expected FPR/TPR', () => {
    const labels = [0, 0, 1, 1];
    const scores = [0.1, 0.2, 0.8, 0.9];
    const { points } = rocCurve(labels, scores);
    // thresholds desc: 0.9 -> (0,0.5), 0.8 -> (0,1), 0.2 -> (0.5,1), 0.1 -> (1,1)
    expect(hasPoint(points, 0, 0.5)).toBe(true);
    expect(hasPoint(points, 0.5, 1)).toBe(true);
  });

  it('dedupes tied scores into a single threshold', () => {
    const labels = [1, 0, 1, 0];
    const scores = [0.5, 0.5, 0.5, 0.5];
    const { points } = rocCurve(labels, scores);
    // (0,0) + one threshold (all predicted positive -> (1,1)) + closing (1,1)
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ]);
  });
});

describe('prCurve', () => {
  it('perfect separation gives average precision 1', () => {
    const labels = [0, 0, 1, 1];
    const scores = [0.1, 0.2, 0.8, 0.9];
    const { points, ap } = prCurve(labels, scores);
    expect(ap).toBeCloseTo(1, 10);
    // highest threshold: recall 0.5, precision 1
    expect(hasPoint(points, 0.5, 1)).toBe(true);
    // full recall reached
    expect(points.some((p) => Math.abs(p.x - 1) < 1e-9)).toBe(true);
  });

  it('precision at full recall equals prevalence', () => {
    // 2 positives out of 4 -> at threshold that admits everything precision = 0.5
    const labels = [0, 0, 1, 1];
    const scores = [0.1, 0.2, 0.8, 0.9];
    const { points } = prCurve(labels, scores);
    const last = points[points.length - 1]!;
    expect(last.x).toBeCloseTo(1, 10);
    expect(last.y).toBeCloseTo(0.5, 10);
  });
});

describe('calibrationCurve', () => {
  it('well-calibrated data sits exactly on the diagonal', () => {
    // bin at 0.25 -> 1/4 positive; bin at 0.75 -> 3/4 positive
    const labels = [1, 0, 0, 0, 1, 1, 1, 0];
    const scores = [0.25, 0.25, 0.25, 0.25, 0.75, 0.75, 0.75, 0.75];
    const { points, perfect } = calibrationCurve(labels, scores);
    expect(points).toHaveLength(2);
    expect(points[0]!.x).toBeCloseTo(0.25, 10);
    expect(points[0]!.y).toBeCloseTo(0.25, 10);
    expect(points[1]!.x).toBeCloseTo(0.75, 10);
    expect(points[1]!.y).toBeCloseTo(0.75, 10);
    // each point lies near the diagonal
    for (const p of points) expect(Math.abs(p.x - p.y)).toBeLessThan(1e-9);
    expect(perfect).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it('skips empty bins and honors custom bin count', () => {
    const labels = [0, 1];
    const scores = [0.1, 0.9];
    const { points } = calibrationCurve(labels, scores, 2);
    // 2 bins: [0,0.5) has score 0.1 (label 0); [0.5,1] has 0.9 (label 1)
    expect(points).toEqual([
      { x: 0.1, y: 0 },
      { x: 0.9, y: 1 },
    ]);
  });
});

describe('confusionCounts', () => {
  it('counts at default threshold 0.5', () => {
    const labels = [0, 0, 1, 1];
    const scores = [0.1, 0.2, 0.8, 0.9];
    expect(confusionCounts(labels, scores)).toEqual({ tp: 2, fp: 0, fn: 0, tn: 2 });
  });

  it('shifting the threshold trades sensitivity for specificity', () => {
    const labels = [0, 1, 1, 1];
    const scores = [0.4, 0.4, 0.6, 0.9];
    // threshold 0.5: predicted pos = {0.6,0.9} both label1 -> tp2, one label-1 at 0.4 is fn, the 0.4 label0 is tn
    expect(confusionCounts(labels, scores, 0.5)).toEqual({ tp: 2, fp: 0, fn: 1, tn: 1 });
    // threshold 0.3: all predicted positive -> tp3, fp1
    expect(confusionCounts(labels, scores, 0.3)).toEqual({ tp: 3, fp: 1, fn: 0, tn: 0 });
  });

  it('throws on length mismatch', () => {
    expect(() => confusionCounts([0, 1], [0.5])).toThrow();
  });
});
