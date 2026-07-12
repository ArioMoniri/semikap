import { describe, expect, it } from 'vitest';
import {
  basenameStem,
  pairImagesAndMasks,
  type BatchCase,
} from '../src/lib/benchmark/batch';

describe('basenameStem', () => {
  it('strips directory and a compound imaging extension', () => {
    expect(basenameStem('path/to/CT_01.nii.gz')).toBe('CT_01');
  });

  it('strips a single imaging extension and a trailing GT suffix', () => {
    expect(basenameStem('a_mask.nrrd')).toBe('a');
  });

  it('handles a bare name with no directory or extension', () => {
    expect(basenameStem('case001')).toBe('case001');
  });

  it('is case-insensitive for extensions', () => {
    expect(basenameStem('CASE.NII.GZ')).toBe('CASE');
    expect(basenameStem('scan.DICOM')).toBe('scan');
  });

  it('is case-insensitive for GT suffixes', () => {
    expect(basenameStem('tumor_SEG.nii.gz')).toBe('tumor');
    expect(basenameStem('organ-Mask.nrrd')).toBe('organ');
  });

  it('strips Windows-style directory separators', () => {
    expect(basenameStem('C:\\data\\patient_gt.mha')).toBe('patient');
  });

  it('strips at most one imaging extension', () => {
    // Only '.gz' is stripped; the remaining '.nrrd' is not an extension here
    // because it does not sit at the very end after '.gz' removal.
    expect(basenameStem('vol.nrrd.gz')).toBe('vol.nrrd');
  });

  it('strips at most one GT suffix', () => {
    // '_labels' is a suffix; after stripping it, '_seg' remains untouched.
    expect(basenameStem('x_seg_labels.nii')).toBe('x_seg');
  });

  it('strips the longest matching compound extension over its suffix', () => {
    // '.nii.gz' must win over a plain '.gz' match.
    expect(basenameStem('foo.nii.gz')).toBe('foo');
  });

  it('does not strip an extension that would leave an empty stem', () => {
    expect(basenameStem('.nii')).toBe('.nii');
  });

  it('does not strip a GT suffix that would leave an empty stem', () => {
    expect(basenameStem('_seg')).toBe('_seg');
  });

  it('preserves inner GT-like tokens that are not trailing', () => {
    expect(basenameStem('seg_case.nii.gz')).toBe('seg_case');
  });
});

describe('pairImagesAndMasks', () => {
  it('pairs images with masks by stem and leaves unmatched images undefined', () => {
    const result = pairImagesAndMasks(
      ['case001.nii.gz', 'case002.nii.gz'],
      ['case001_seg.nii.gz'],
    );
    expect(result).toEqual<BatchCase[]>([
      {
        caseId: 'case001',
        imageName: 'case001.nii.gz',
        referenceName: 'case001_seg.nii.gz',
      },
      { caseId: 'case002', imageName: 'case002.nii.gz' },
    ]);
  });

  it('omits referenceName when there is no matching mask', () => {
    const [only] = pairImagesAndMasks(['a.nii.gz'], []);
    expect(only).toBeDefined();
    expect('referenceName' in only!).toBe(false);
  });

  it('preserves image order', () => {
    const result = pairImagesAndMasks(
      ['b.nii.gz', 'a.nii.gz', 'c.nii.gz'],
      [],
    );
    expect(result.map((c) => c.caseId)).toEqual(['b', 'a', 'c']);
  });

  it('dedupes images with the same stem, first wins', () => {
    const result = pairImagesAndMasks(
      ['case001.nii.gz', 'case001.nrrd'],
      ['case001_mask.nii.gz'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual<BatchCase>({
      caseId: 'case001',
      imageName: 'case001.nii.gz',
      referenceName: 'case001_mask.nii.gz',
    });
  });

  it('uses the first mask when several share a stem', () => {
    const result = pairImagesAndMasks(
      ['t.nii.gz'],
      ['t_seg.nii.gz', 't_mask.nii.gz'],
    );
    expect(result[0]!.referenceName).toBe('t_seg.nii.gz');
  });

  it('matches masks across differing directory separators', () => {
    const result = pairImagesAndMasks(
      ['imgs/Case_01.nii.gz'],
      ['masks\\Case_01-gt.nrrd'],
    );
    expect(result[0]!.referenceName).toBe('masks\\Case_01-gt.nrrd');
  });

  it('does not match masks whose stem differs only by case', () => {
    // Stem comparison is exact; only extension/suffix stripping is case-insensitive.
    const [only] = pairImagesAndMasks(['Case_01.nii.gz'], ['CASE_01_seg.nii.gz']);
    expect(only!.referenceName).toBeUndefined();
  });

  it('returns an empty list for no images', () => {
    expect(pairImagesAndMasks([], ['x_seg.nii.gz'])).toEqual([]);
  });
});
