import { describe, expect, it } from 'vitest';

import {
  extractCaseMeta,
  normalizeModality,
  parseAgeYears,
} from '../src/lib/datasets/dicom-meta';

describe('normalizeModality', () => {
  it('maps DX and CR to XR', () => {
    expect(normalizeModality('DX')).toBe('XR');
    expect(normalizeModality('CR')).toBe('XR');
  });
  it('passes through CT/MR/PT/US/XR', () => {
    expect(normalizeModality('CT')).toBe('CT');
    expect(normalizeModality('MR')).toBe('MR');
    expect(normalizeModality('PT')).toBe('PT');
    expect(normalizeModality('US')).toBe('US');
    expect(normalizeModality('XR')).toBe('XR');
  });
  it('is case/whitespace insensitive', () => {
    expect(normalizeModality('  ct ')).toBe('CT');
  });
  it('maps unknown to Other', () => {
    expect(normalizeModality('NM')).toBe('Other');
    expect(normalizeModality('')).toBe('Other');
  });
});

describe('parseAgeYears', () => {
  it('parses years unit', () => {
    expect(parseAgeYears('045Y')).toBe(45);
    expect(parseAgeYears('7Y')).toBe(7);
  });
  it('omits non-year units and malformed values', () => {
    expect(parseAgeYears('012M')).toBeUndefined();
    expect(parseAgeYears('052W')).toBeUndefined();
    expect(parseAgeYears('045')).toBeUndefined();
    expect(parseAgeYears('')).toBeUndefined();
  });
});

describe('extractCaseMeta', () => {
  it('extracts a full tag map into all CaseMeta fields', () => {
    const meta = extractCaseMeta({
      '00080060': 'CT',
      '00180015': 'LIVER',
      '00080070': 'SIEMENS',
      '00081090': 'SOMATOM Force',
      '00081010': 'CT01',
      '00181020': 'syngo CT VA48',
      '00180050': '2.5',
      '00080020': '20240115',
      '00100040': 'F',
      '00101010': '045Y',
      '00180010': 'IODINE',
    });
    expect(meta).toEqual({
      modality: 'CT',
      bodyPart: 'LIVER',
      manufacturer: 'SIEMENS',
      modelName: 'SOMATOM Force',
      stationName: 'CT01',
      softwareVersion: 'syngo CT VA48',
      sliceThicknessMm: 2.5,
      studyDate: '20240115',
      sex: 'F',
      ageYears: 45,
      contrast: true,
    });
  });

  it('normalizes DX modality to XR', () => {
    expect(extractCaseMeta({ '00080060': 'DX' }).modality).toBe('XR');
  });

  it('omits an unrecognized sex value', () => {
    const meta = extractCaseMeta({ '00100040': 'X' });
    expect(meta.sex).toBeUndefined();
    expect('sex' in meta).toBe(false);
  });

  it('sets contrast false for a NO agent, but still sets the key', () => {
    const meta = extractCaseMeta({ '00180010': 'NO' });
    expect(meta.contrast).toBe(false);
    expect('contrast' in meta).toBe(true);
  });

  it('omits contrast entirely when the agent tag is absent or empty', () => {
    expect('contrast' in extractCaseMeta({})).toBe(false);
    expect('contrast' in extractCaseMeta({ '00180010': '   ' })).toBe(false);
  });

  it('skips a NaN slice thickness', () => {
    const meta = extractCaseMeta({ '00180050': 'n/a' });
    expect('sliceThicknessMm' in meta).toBe(false);
  });

  it('rejects a malformed study date', () => {
    expect('studyDate' in extractCaseMeta({ '00080020': '2024-01-15' })).toBe(
      false,
    );
    expect(extractCaseMeta({ '00080020': '20240115' }).studyDate).toBe(
      '20240115',
    );
  });

  it('returns an empty CaseMeta for an empty / unknown tag map', () => {
    expect(extractCaseMeta({})).toEqual({});
    expect(extractCaseMeta({ '99999999': 'ignored', '00100010': 'PHI' })).toEqual(
      {},
    );
  });
});
