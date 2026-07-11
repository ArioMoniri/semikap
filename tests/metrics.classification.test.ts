import { describe, expect, it } from 'vitest';
import {
  thresholdMetrics,
  auroc,
  auprc,
  brierScore,
  expectedCalibrationError,
  classificationMetrics,
} from '../src/lib/metrics/classification';

describe('thresholdMetrics', () => {
  it('computes confusion metrics at threshold 0.5', () => {
    const labels = [1, 1, 0, 0];
    const scores = [0.9, 0.4, 0.6, 0.1];
    const m = thresholdMetrics(labels, scores, 0.5);
    // tp: 0.9→1 ; fn: 0.4→1 ; fp: 0.6→1 ; tn: 0.1→1
    expect(m).toMatchObject({ tp: 1, fn: 1, fp: 1, tn: 1 });
    expect(m.accuracy).toBeCloseTo(0.5, 6);
    expect(m.sensitivity).toBeCloseTo(0.5, 6);
    expect(m.specificity).toBeCloseTo(0.5, 6);
  });
  it('throws on length mismatch and empty', () => {
    expect(() => thresholdMetrics([1], [0.5, 0.5])).toThrow();
    expect(() => thresholdMetrics([], [])).toThrow();
  });
});

describe('auroc', () => {
  it('perfect ranking → 1', () => {
    expect(auroc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9])).toBeCloseTo(1, 6);
  });
  it('inverted ranking → 0', () => {
    expect(auroc([1, 1, 0, 0], [0.1, 0.2, 0.8, 0.9])).toBeCloseTo(0, 6);
  });
  it('handles tied scores via average ranks → 0.5', () => {
    expect(auroc([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5])).toBeCloseTo(0.5, 6);
  });
  it('NaN when a class is absent', () => {
    expect(Number.isNaN(auroc([1, 1, 1], [0.2, 0.6, 0.9]))).toBe(true);
  });
});

describe('auprc', () => {
  it('perfect ranking → 1', () => {
    expect(auprc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9])).toBeCloseTo(1, 6);
  });
  it('NaN when no positives', () => {
    expect(Number.isNaN(auprc([0, 0, 0], [0.2, 0.5, 0.9]))).toBe(true);
  });
});

describe('brierScore', () => {
  it('perfect confident predictions → 0', () => {
    expect(brierScore([1, 0], [1, 0])).toBeCloseTo(0, 6);
  });
  it('0.5 everywhere → 0.25', () => {
    expect(brierScore([1, 0, 1, 0], [0.5, 0.5, 0.5, 0.5])).toBeCloseTo(0.25, 6);
  });
});

describe('expectedCalibrationError', () => {
  it('perfectly calibrated confident predictions → 0', () => {
    expect(expectedCalibrationError([1, 1, 0, 0], [1, 1, 0, 0], 10)).toBeCloseTo(0, 6);
  });
  it('miscalibration is positive', () => {
    // all scored 0.9 but half are negative → confidence 0.9, accuracy 0.5.
    const ece = expectedCalibrationError([1, 1, 0, 0], [0.9, 0.9, 0.9, 0.9], 10);
    expect(ece).toBeCloseTo(0.4, 6);
  });
});

describe('classificationMetrics', () => {
  it('bundles everything', () => {
    const m = classificationMetrics([1, 1, 0, 0], [0.9, 0.6, 0.4, 0.1]);
    expect(m.auroc).toBeCloseTo(1, 6);
    expect(m.n).toBe(4);
    expect(m.positives).toBe(2);
    expect(m.accuracy).toBeCloseTo(1, 6);
  });
});
