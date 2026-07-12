import { describe, expect, it } from 'vitest';
import { parseBoxesJson, boxesByCase, type Box } from '../src/lib/datasets/boxes';

describe('parseBoxesJson', () => {
  it('parses a valid 2D box and a 3D box', () => {
    const text = JSON.stringify([
      { caseId: 'case-1', x: 10, y: 20, w: 30, h: 40 },
      { caseId: 'case-2', x: 1, y: 2, w: 3, h: 4, z: 5, d: 6, score: 0.75, label: 'lesion' },
    ]);
    const boxes = parseBoxesJson(text);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toEqual({ caseId: 'case-1', x: 10, y: 20, w: 30, h: 40 });
    expect(boxes[1]).toEqual({
      caseId: 'case-2',
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      z: 5,
      d: 6,
      score: 0.75,
      label: 'lesion',
    });
    // Optional fields absent on the 2D box.
    expect(boxes[0]!.z).toBeUndefined();
    expect(boxes[0]!.score).toBeUndefined();
  });

  it('accepts score boundaries 0 and 1 and zero-size boxes', () => {
    const boxes = parseBoxesJson(
      JSON.stringify([
        { caseId: 'a', x: -5, y: -5, w: 0, h: 0, score: 0 },
        { caseId: 'b', x: 0, y: 0, w: 100, h: 100, score: 1 },
      ]),
    );
    expect(boxes[0]!.w).toBe(0);
    expect(boxes[0]!.score).toBe(0);
    expect(boxes[1]!.score).toBe(1);
  });

  it('rejects negative width', () => {
    expect(() => parseBoxesJson(JSON.stringify([{ caseId: 'a', x: 0, y: 0, w: -1, h: 5 }]))).toThrow(
      /boxes\[0\]: w must be a finite number >= 0/,
    );
  });

  it('rejects missing caseId', () => {
    expect(() => parseBoxesJson(JSON.stringify([{ x: 0, y: 0, w: 5, h: 5 }]))).toThrow(
      /boxes\[0\]: caseId must be a non-empty string/,
    );
  });

  it('rejects an empty-string caseId', () => {
    expect(() => parseBoxesJson(JSON.stringify([{ caseId: '', x: 0, y: 0, w: 5, h: 5 }]))).toThrow(
      /caseId must be a non-empty string/,
    );
  });

  it('rejects a non-array top level', () => {
    expect(() => parseBoxesJson(JSON.stringify({ caseId: 'a', x: 0, y: 0, w: 1, h: 1 }))).toThrow(
      /expected a JSON array of boxes/,
    );
  });

  it('rejects out-of-range score and non-finite coordinates', () => {
    expect(() =>
      parseBoxesJson(JSON.stringify([{ caseId: 'a', x: 0, y: 0, w: 1, h: 1, score: 1.5 }])),
    ).toThrow(/score must be a number in \[0,1\]/);
    // NaN is not valid JSON, so a null coordinate exercises the finite check.
    expect(() =>
      parseBoxesJson(JSON.stringify([{ caseId: 'a', x: null, y: 0, w: 1, h: 1 }])),
    ).toThrow(/x must be a finite number/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseBoxesJson('{not json')).toThrow(/invalid JSON/);
  });
});

describe('boxesByCase', () => {
  it('groups boxes by caseId preserving order', () => {
    const boxes: Box[] = [
      { caseId: 'a', x: 0, y: 0, w: 1, h: 1 },
      { caseId: 'b', x: 0, y: 0, w: 2, h: 2 },
      { caseId: 'a', x: 0, y: 0, w: 3, h: 3 },
    ];
    const grouped = boxesByCase(boxes);
    expect(grouped.size).toBe(2);
    expect(grouped.get('a')).toHaveLength(2);
    expect(grouped.get('a')!.map((b) => b.w)).toEqual([1, 3]);
    expect(grouped.get('b')).toHaveLength(1);
    expect(grouped.get('b')![0]!.w).toBe(2);
  });

  it('returns an empty map for no boxes', () => {
    expect(boxesByCase([]).size).toBe(0);
  });
});
