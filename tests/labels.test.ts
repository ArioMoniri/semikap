import { describe, expect, it } from 'vitest';
import {
  parseLabelCsv,
  parseLabelJson,
  toLabelsAndScores,
  type CaseLabel,
} from '../src/lib/datasets/labels';

describe('parseLabelCsv', () => {
  it('parses header plus three rows including a score column', () => {
    const csv = 'caseId,label,score\nc1,1,0.9\nc2,0,0.1\nc3,1,0.75';
    const rows = parseLabelCsv(csv);
    expect(rows).toEqual<CaseLabel[]>([
      { caseId: 'c1', label: 1, score: 0.9 },
      { caseId: 'c2', label: 0, score: 0.1 },
      { caseId: 'c3', label: 1, score: 0.75 },
    ]);
  });

  it('accepts header synonyms (Class / Prob) case-insensitively', () => {
    const csv = 'Accession,Class,Prob\nA1,1,0.8\nA2,0,0.2';
    const rows = parseLabelCsv(csv);
    expect(rows).toEqual<CaseLabel[]>([
      { caseId: 'A1', label: 1, score: 0.8 },
      { caseId: 'A2', label: 0, score: 0.2 },
    ]);
  });

  it("parses 'positive'/'negative' and true/false/present/absent labels", () => {
    const csv = 'id,truth\nx1,positive\nx2,negative\nx3,TRUE\nx4,absent';
    const rows = parseLabelCsv(csv);
    expect(rows.map((r) => r.label)).toEqual([1, 0, 1, 0]);
  });

  it('skips blank lines and leading blank rows before the header', () => {
    const csv = '\n\ncase,label\n\nc1,1\n\nc2,0\n';
    const rows = parseLabelCsv(csv);
    expect(rows).toEqual<CaseLabel[]>([
      { caseId: 'c1', label: 1 },
      { caseId: 'c2', label: 0 },
    ]);
  });

  it('leaves score undefined when there is no score column', () => {
    const rows = parseLabelCsv('id,label\nc1,1\nc2,0');
    expect(rows[0]!.score).toBeUndefined();
    expect(rows[1]!.score).toBeUndefined();
  });

  it('throws when the label column is missing', () => {
    expect(() => parseLabelCsv('caseId,score\nc1,0.9')).toThrow(/label column/i);
  });

  it('throws when the caseId column is missing', () => {
    expect(() => parseLabelCsv('label,score\n1,0.9')).toThrow(/caseId column/i);
  });

  it('throws on an unparseable label value', () => {
    expect(() => parseLabelCsv('id,label\nc1,maybe')).toThrow(/Unparseable label/i);
  });
});

describe('parseLabelJson', () => {
  it('parses a JSON array of label objects', () => {
    const json = JSON.stringify([
      { caseId: 'c1', label: 1, score: 0.9 },
      { caseId: 'c2', label: 0 },
    ]);
    expect(parseLabelJson(json)).toEqual<CaseLabel[]>([
      { caseId: 'c1', label: 1, score: 0.9 },
      { caseId: 'c2', label: 0 },
    ]);
  });

  it('coerces boolean and string labels to 0/1', () => {
    const json = JSON.stringify([
      { caseId: 'a', label: true },
      { caseId: 'b', label: 'negative' },
      { caseId: 'c', label: '1' },
    ]);
    expect(parseLabelJson(json).map((r) => r.label)).toEqual([1, 0, 1]);
  });

  it('throws on non-array JSON', () => {
    expect(() => parseLabelJson('{"caseId":"c1","label":1}')).toThrow(/array/i);
  });

  it('throws on a row missing caseId', () => {
    expect(() => parseLabelJson('[{"label":1}]')).toThrow(/caseId/i);
  });

  it('throws on an invalid score type', () => {
    expect(() => parseLabelJson('[{"caseId":"c1","label":1,"score":"high"}]')).toThrow(
      /score/i,
    );
  });
});

describe('toLabelsAndScores', () => {
  it('falls back to the label when score is absent, preserving order', () => {
    const rows: CaseLabel[] = [
      { caseId: 'c1', label: 1, score: 0.9 },
      { caseId: 'c2', label: 0 },
      { caseId: 'c3', label: 1 },
    ];
    expect(toLabelsAndScores(rows)).toEqual({
      labels: [1, 0, 1],
      scores: [0.9, 0, 1],
    });
  });

  it('returns empty arrays for empty input', () => {
    expect(toLabelsAndScores([])).toEqual({ labels: [], scores: [] });
  });
});
