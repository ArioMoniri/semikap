import { describe, expect, it } from 'vitest';
import { blandAltman, pearson, type Pair } from '../src/lib/plots/agreement';

describe('blandAltman', () => {
  it('identical pairs -> zero bias, zero SD, degenerate LoA', () => {
    const pairs: Pair[] = [
      { ref: 1, pred: 1 },
      { ref: 2, pred: 2 },
      { ref: 3, pred: 3 },
    ];
    const ba = blandAltman(pairs);
    expect(ba.bias).toBe(0);
    expect(ba.sdDiff).toBe(0);
    expect(ba.loaLow).toBe(0);
    expect(ba.loaHigh).toBe(0);
    expect(ba.points).toEqual([
      { mean: 1, diff: 0 },
      { mean: 2, diff: 0 },
      { mean: 3, diff: 0 },
    ]);
  });

  it('hand-computed: diffs 1,2,3 -> bias 2, sample SD 1, LoA 2±1.96', () => {
    // pred = 2*ref; diffs = 1,2,3; mean diff = 2; sample var = 2/(3-1)=1 -> SD 1
    const pairs: Pair[] = [
      { ref: 1, pred: 2 },
      { ref: 2, pred: 4 },
      { ref: 3, pred: 6 },
    ];
    const ba = blandAltman(pairs);
    expect(ba.bias).toBeCloseTo(2, 12);
    expect(ba.sdDiff).toBeCloseTo(1, 12);
    expect(ba.loaLow).toBeCloseTo(0.04, 12);
    expect(ba.loaHigh).toBeCloseTo(3.96, 12);
    expect(ba.points).toEqual([
      { mean: 1.5, diff: 1 },
      { mean: 3, diff: 2 },
      { mean: 4.5, diff: 3 },
    ]);
  });

  it('empty input -> NaN summary but empty points array', () => {
    const ba = blandAltman([]);
    expect(ba.points).toEqual([]);
    expect(ba.bias).toBeNaN();
    expect(ba.sdDiff).toBeNaN();
    expect(ba.loaLow).toBeNaN();
    expect(ba.loaHigh).toBeNaN();
  });

  it('single pair -> defined bias, NaN SD (n-1 = 0)', () => {
    const ba = blandAltman([{ ref: 4, pred: 7 }]);
    expect(ba.bias).toBe(3);
    expect(ba.sdDiff).toBeNaN();
    expect(ba.loaLow).toBeNaN();
    expect(ba.loaHigh).toBeNaN();
    expect(ba.points).toEqual([{ mean: 5.5, diff: 3 }]);
  });
});

describe('pearson', () => {
  it('perfect positive linear relation -> r = 1', () => {
    const pairs: Pair[] = [
      { ref: 1, pred: 2 },
      { ref: 2, pred: 4 },
      { ref: 3, pred: 6 },
    ];
    expect(pearson(pairs)).toBeCloseTo(1, 12);
  });

  it('identical pairs with variation across pairs -> r = 1', () => {
    const pairs: Pair[] = [
      { ref: 1, pred: 1 },
      { ref: 2, pred: 2 },
      { ref: 3, pred: 3 },
    ];
    expect(pearson(pairs)).toBeCloseTo(1, 12);
  });

  it('hand-computed r = 0.6', () => {
    // ref=[1,2,3,4] pred=[2,1,4,3]; cov=3, ssRef=ssPred=5 -> r=3/5=0.6
    const pairs: Pair[] = [
      { ref: 1, pred: 2 },
      { ref: 2, pred: 1 },
      { ref: 3, pred: 4 },
      { ref: 4, pred: 3 },
    ];
    expect(pearson(pairs)).toBeCloseTo(0.6, 12);
  });

  it('perfect negative relation -> r = -1', () => {
    const pairs: Pair[] = [
      { ref: 1, pred: 6 },
      { ref: 2, pred: 4 },
      { ref: 3, pred: 2 },
    ];
    expect(pearson(pairs)).toBeCloseTo(-1, 12);
  });

  it('fewer than two pairs -> NaN', () => {
    expect(pearson([])).toBeNaN();
    expect(pearson([{ ref: 1, pred: 2 }])).toBeNaN();
  });

  it('zero variance on either side -> NaN', () => {
    expect(
      pearson([
        { ref: 5, pred: 1 },
        { ref: 5, pred: 2 },
        { ref: 5, pred: 3 },
      ]),
    ).toBeNaN();
    expect(
      pearson([
        { ref: 1, pred: 7 },
        { ref: 2, pred: 7 },
      ]),
    ).toBeNaN();
  });
});
