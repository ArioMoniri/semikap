import { describe, expect, it } from 'vitest';
import { segRowsToRecords } from '../src/lib/benchmark/import-records';
import { parseSegResultsCsv } from '../src/lib/stats/results-import';
import { summarizeSegmentation } from '../src/lib/benchmark/types';

describe('segRowsToRecords', () => {
  it('lifts imported rows into valid segmentation records (one per row)', () => {
    const rows = parseSegResultsCsv(
      ['caseId,model,dice,iou,hd95', 'c1,alpha,0.9,0.8,3.2', 'c1,beta,0.7,0.6,5.1'].join('\n'),
    );
    const recs = segRowsToRecords(rows, { profileId: 'p1', appVersion: '9.9.9' });
    expect(recs).toHaveLength(2);
    expect(recs[0]!.model.name).toBe('alpha');
    expect(recs[0]!.model.version).toBe('imported');
    expect(recs[0]!.task).toBe('segmentation');
    expect(recs[0]!.case.caseId).toBe('c1');
    expect(recs[0]!.segmentation?.[0]!.dice).toBeCloseTo(0.9, 6);
    expect(recs[0]!.segmentation?.[0]!.iou).toBeCloseTo(0.8, 6);
    expect(recs[0]!.segmentation?.[0]!.hd95Mm).toBeCloseTo(3.2, 6);
    expect(recs[0]!.appVersion).toBe('9.9.9');
  });

  it('stores missing optional metrics as NaN (aggregators skip them)', () => {
    const rows = parseSegResultsCsv(['caseId,model,dice', 'c1,alpha,0.5'].join('\n'));
    const [rec] = segRowsToRecords(rows, { profileId: 'p1', appVersion: '1.0.0' });
    expect(Number.isNaN(rec!.segmentation![0]!.iou)).toBe(true);
    expect(Number.isNaN(rec!.segmentation![0]!.hd95Mm)).toBe(true);
  });

  it('produces records that summarizeSegmentation groups by model', () => {
    const rows = parseSegResultsCsv(
      [
        'caseId,model,dice',
        'c1,alpha,0.9',
        'c2,alpha,0.8',
        'c1,beta,0.6',
        'c2,beta,0.7',
      ].join('\n'),
    );
    const recs = segRowsToRecords(rows, { profileId: 'p1', appVersion: '1.0.0' });
    const summary = summarizeSegmentation(recs);
    expect(summary).toHaveLength(2);
    const alpha = summary.find((s) => s.modelName === 'alpha')!;
    expect(alpha.cases).toBe(2);
    expect(alpha.meanDice).toBeCloseTo(0.85, 6);
  });

  it('uses a stable default id and honors a custom id generator', () => {
    const rows = parseSegResultsCsv(['caseId,model,dice', 'c1,alpha,0.5'].join('\n'));
    const def = segRowsToRecords(rows, { profileId: 'p', appVersion: '1' });
    expect(def[0]!.id).toBe('imported:alpha:c1');
    const custom = segRowsToRecords(rows, {
      profileId: 'p',
      appVersion: '1',
      idFor: (_r, i) => `row-${i}`,
    });
    expect(custom[0]!.id).toBe('row-0');
  });
});
