import { describe, expect, it } from 'vitest';
import { histogram, forestFromGroups, type Bin } from '../src/lib/plots/distributions';

describe('histogram', () => {
  it('buckets [1..10] into 5 bins with counts summing to 10', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const bins = histogram(values, 5);
    expect(bins).toHaveLength(5);
    const total = bins.reduce((a, b) => a + b.count, 0);
    expect(total).toBe(10);
    // width = 9/5 = 1.8; each bin holds exactly 2 of the integers.
    expect(bins.map((b) => b.count)).toEqual([2, 2, 2, 2, 2]);
    expect(bins[0]!.x0).toBeCloseTo(1, 10);
    expect(bins[0]!.x1).toBeCloseTo(2.8, 10);
    expect(bins[4]!.x1).toBeCloseTo(10, 10);
  });

  it('returns [] for empty input', () => {
    expect(histogram([])).toEqual([]);
    expect(histogram([Number.NaN, Number.POSITIVE_INFINITY])).toEqual([]);
  });

  it('returns a single degenerate bin when all values are equal', () => {
    const bins: Bin[] = histogram([5, 5, 5], 4);
    expect(bins).toEqual([{ x0: 5, x1: 5, count: 3 }]);
  });

  it('ignores NaN values and counts the maximum in the last bin', () => {
    const bins = histogram([0, Number.NaN, 10], 2);
    const total = bins.reduce((a, b) => a + b.count, 0);
    expect(total).toBe(2);
    expect(bins).toHaveLength(2);
    expect(bins[1]!.count).toBe(1); // the value 10 lands in the closed last bin
  });

  it('defaults to 10 bins', () => {
    expect(histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toHaveLength(10);
  });
});

describe('forestFromGroups', () => {
  it('computes mean and 95% CI for a known group', () => {
    // values [1,2,3,4,5]: mean=3, sample sd=sqrt(2.5)=1.5811, se=sd/sqrt(5)=0.70711
    // half = 1.96*0.70711 = 1.38593
    const rows = forestFromGroups([{ label: 'A', values: [1, 2, 3, 4, 5] }]);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.label).toBe('A');
    expect(r.n).toBe(5);
    expect(r.value).toBeCloseTo(3, 10);
    expect(r.low).toBeCloseTo(1.614074, 5);
    expect(r.high).toBeCloseTo(4.385926, 5);
  });

  it('ignores NaN values in the finite count and mean', () => {
    const rows = forestFromGroups([{ label: 'B', values: [2, Number.NaN, 4] }]);
    const r = rows[0]!;
    expect(r.n).toBe(2);
    expect(r.value).toBeCloseTo(3, 10);
    // sd of [2,4] = sqrt(2)=1.41421, se=1/1... se = 1.41421/sqrt(2)=1, half=1.96
    expect(r.low).toBeCloseTo(3 - 1.96, 6);
    expect(r.high).toBeCloseTo(3 + 1.96, 6);
  });

  it('gives se=0 (low=high=mean) for a single-value group', () => {
    const r = forestFromGroups([{ label: 'C', values: [7] }])[0]!;
    expect(r.n).toBe(1);
    expect(r.value).toBe(7);
    expect(r.low).toBe(7);
    expect(r.high).toBe(7);
  });

  it('yields NaN estimates for an empty group', () => {
    const r = forestFromGroups([{ label: 'D', values: [] }])[0]!;
    expect(r.n).toBe(0);
    expect(Number.isNaN(r.value)).toBe(true);
    expect(Number.isNaN(r.low)).toBe(true);
    expect(Number.isNaN(r.high)).toBe(true);
  });

  it('returns [] for empty input', () => {
    expect(forestFromGroups([])).toEqual([]);
  });
});
