import { describe, expect, it } from 'vitest';
import {
  parseSegResultsCsv,
  pairSegResults,
  parseClsResultsCsv,
  type SegResultRow,
} from '../src/lib/stats/results-import';

describe('parseSegResultsCsv — comma, 2 models, 3 cases', () => {
  const csv = [
    'caseId,model,dice,iou',
    'c1,modelA,0.90,0.82',
    'c1,modelB,0.80,0.67',
    'c2,modelA,0.70,0.54',
    'c2,modelB,0.60,0.43',
    'c3,modelA,0.50,0.33',
    'c3,modelB,0.40,0.25',
  ].join('\n');

  it('parses 6 rows with the right fields', () => {
    const rows = parseSegResultsCsv(csv);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ caseId: 'c1', model: 'modelA', dice: 0.9, iou: 0.82 });
    expect(rows[5]).toEqual({ caseId: 'c3', model: 'modelB', dice: 0.4, iou: 0.25 });
  });

  it('pairs by case and computes A-B diffs for dice', () => {
    const rows = parseSegResultsCsv(csv);
    const paired = pairSegResults(rows, 'modelA', 'modelB', 'dice');
    expect(paired.caseIds).toEqual(['c1', 'c2', 'c3']);
    expect(paired.a).toEqual([0.9, 0.7, 0.5]);
    expect(paired.b).toEqual([0.8, 0.6, 0.4]);
    // 0.9-0.8, 0.7-0.6, 0.5-0.4 (allow fp slack)
    expect(paired.diffs[0]!).toBeCloseTo(0.1, 12);
    expect(paired.diffs[1]!).toBeCloseTo(0.1, 12);
    expect(paired.diffs[2]!).toBeCloseTo(0.1, 12);
  });

  it('pairs on iou too', () => {
    const rows = parseSegResultsCsv(csv);
    const paired = pairSegResults(rows, 'modelA', 'modelB', 'iou');
    expect(paired.a).toEqual([0.82, 0.54, 0.33]);
    expect(paired.b).toEqual([0.67, 0.43, 0.25]);
  });
});

describe('parseSegResultsCsv — TAB delimited + header aliases', () => {
  const tsv = [
    'Case\tMethod\tDSC\tJaccard\tHD95',
    'a1\tunet\t0.95\t0.90\t3.2',
    'a1\tnnunet\t0.97\t0.94\t2.1',
  ].join('\n');

  it('auto-detects TAB and resolves DSC/Jaccard/HD95 aliases', () => {
    const rows = parseSegResultsCsv(tsv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      caseId: 'a1',
      model: 'unet',
      dice: 0.95,
      iou: 0.9,
      hd95Mm: 3.2,
    });
    expect(rows[1]!.hd95Mm).toBe(2.1);
  });

  it('pairs hd95 with correct sign', () => {
    const rows = parseSegResultsCsv(tsv);
    const paired = pairSegResults(rows, 'unet', 'nnunet', 'hd95Mm');
    expect(paired.caseIds).toEqual(['a1']);
    expect(paired.diffs[0]!).toBeCloseTo(3.2 - 2.1, 12);
  });
});

describe('pairSegResults — unpaired / missing-metric cases dropped', () => {
  it('drops a case present for only one model', () => {
    const rows: SegResultRow[] = [
      { caseId: 'c1', model: 'A', dice: 0.9 },
      { caseId: 'c1', model: 'B', dice: 0.8 },
      { caseId: 'c2', model: 'A', dice: 0.7 }, // no B row
    ];
    const paired = pairSegResults(rows, 'A', 'B', 'dice');
    expect(paired.caseIds).toEqual(['c1']);
    expect(paired.diffs).toHaveLength(1);
  });

  it('drops a case missing the chosen metric for one model', () => {
    const rows: SegResultRow[] = [
      { caseId: 'c1', model: 'A', dice: 0.9, iou: 0.8 },
      { caseId: 'c1', model: 'B', dice: 0.8 }, // no iou
    ];
    const onDice = pairSegResults(rows, 'A', 'B', 'dice');
    expect(onDice.caseIds).toEqual(['c1']);
    const onIou = pairSegResults(rows, 'A', 'B', 'iou');
    expect(onIou.caseIds).toEqual([]);
  });

  it('preserves first-appearance order', () => {
    const rows: SegResultRow[] = [
      { caseId: 'z', model: 'A', dice: 0.5 },
      { caseId: 'a', model: 'A', dice: 0.6 },
      { caseId: 'z', model: 'B', dice: 0.4 },
      { caseId: 'a', model: 'B', dice: 0.55 },
    ];
    const paired = pairSegResults(rows, 'A', 'B', 'dice');
    expect(paired.caseIds).toEqual(['z', 'a']);
  });
});

describe('parseSegResultsCsv — error cases', () => {
  it('throws when the dice column is missing', () => {
    const csv = ['caseId,model,iou', 'c1,A,0.8'].join('\n');
    expect(() => parseSegResultsCsv(csv)).toThrow(/required column 'dice'/);
  });

  it('throws when caseId column is missing', () => {
    const csv = ['model,dice', 'A,0.8'].join('\n');
    expect(() => parseSegResultsCsv(csv)).toThrow(/required column 'caseId'/);
  });

  it('throws on unparseable dice', () => {
    const csv = ['caseId,model,dice', 'c1,A,notanumber'].join('\n');
    expect(() => parseSegResultsCsv(csv)).toThrow(/unparseable dice/);
  });

  it('skips blank lines', () => {
    const csv = ['caseId,model,dice', '', 'c1,A,0.8', '  ', 'c2,A,0.7'].join('\n');
    expect(parseSegResultsCsv(csv)).toHaveLength(2);
  });
});

describe('parseClsResultsCsv', () => {
  it('parses a comma classification CSV with label coercion', () => {
    const csv = [
      'caseId,label,scoreA,scoreB',
      'c1,1,0.9,0.7',
      'c2,positive,0.6,0.8',
      'c3,false,0.2,0.1',
      'c4,0,0.4,0.3',
    ].join('\n');
    const rows = parseClsResultsCsv(csv);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ caseId: 'c1', label: 1, scoreA: 0.9, scoreB: 0.7 });
    expect(rows[1]!.label).toBe(1); // positive
    expect(rows[2]!.label).toBe(0); // false
    expect(rows[3]!.label).toBe(0);
  });

  it('resolves aliases (truth/proba/probb) and TAB', () => {
    const tsv = ['id\ttruth\tproba\tprobb', 'x\tpresent\t0.55\t0.45'].join('\n');
    const rows = parseClsResultsCsv(tsv);
    expect(rows[0]).toEqual({ caseId: 'x', label: 1, scoreA: 0.55, scoreB: 0.45 });
  });

  it('throws when scoreB is missing', () => {
    const csv = ['caseId,label,scoreA', 'c1,1,0.9'].join('\n');
    expect(() => parseClsResultsCsv(csv)).toThrow(/required column 'scoreB'/);
  });

  it('throws on an uncoercible label', () => {
    const csv = ['caseId,label,scoreA,scoreB', 'c1,maybe,0.9,0.7'].join('\n');
    expect(() => parseClsResultsCsv(csv)).toThrow(/unparseable label/);
  });

  it('throws on unparseable score', () => {
    const csv = ['caseId,label,scoreA,scoreB', 'c1,1,foo,0.7'].join('\n');
    expect(() => parseClsResultsCsv(csv)).toThrow(/unparseable scoreA/);
  });
});
