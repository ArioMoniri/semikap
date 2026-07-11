import { describe, expect, it } from 'vitest';
import { parseDatasetManifest, datasetCompleteness } from '../src/lib/datasets/manifest';

const seg = {
  schema: 'tamias.dataset.v1',
  name: 'Liver CT set',
  task: 'segmentation',
  labels: { 1: 'liver' },
  cases: [
    { caseId: 'c1', imageName: 'a.nii.gz', referenceLabelName: 'a_seg.nii.gz', modality: 'CT', studyDate: '20240101', contrast: true },
    { caseId: 'c2', imageName: 'b.nii.gz' },
  ],
};

describe('parseDatasetManifest', () => {
  it('parses a valid segmentation dataset and derives groundTruthAvailable', () => {
    const ds = parseDatasetManifest(seg);
    expect(ds.name).toBe('Liver CT set');
    expect(ds.task).toBe('segmentation');
    expect(ds.cases[0]!.groundTruthAvailable).toBe(true);
    expect(ds.cases[1]!.groundTruthAvailable).toBe(false);
    expect(ds.labels).toEqual({ 1: 'liver' });
  });

  it('parses a classification dataset with 0/1 references', () => {
    const ds = parseDatasetManifest({
      schema: 'tamias.dataset.v1',
      name: 'CXR',
      task: 'classification',
      cases: [
        { caseId: 'x1', imageName: 'x1.png', referenceClass: 1 },
        { caseId: 'x2', imageName: 'x2.png', referenceClass: 0 },
      ],
    });
    expect(ds.cases[0]!.groundTruthAvailable).toBe(true);
    expect(ds.cases[0]!.referenceClass).toBe(1);
  });

  it('rejects bad schema, bad task, empty cases, dup caseId, bad studyDate, bad class', () => {
    expect(() => parseDatasetManifest({ ...seg, schema: 'x' })).toThrow();
    expect(() => parseDatasetManifest({ ...seg, task: 'foo' })).toThrow();
    expect(() => parseDatasetManifest({ ...seg, cases: [] })).toThrow();
    expect(() =>
      parseDatasetManifest({ ...seg, cases: [{ caseId: 'd', imageName: 'a' }, { caseId: 'd', imageName: 'b' }] })
    ).toThrow();
    expect(() =>
      parseDatasetManifest({ ...seg, cases: [{ caseId: 'c', imageName: 'a', studyDate: '2024' }] })
    ).toThrow();
    expect(() =>
      parseDatasetManifest({
        schema: 'tamias.dataset.v1',
        name: 'c',
        task: 'classification',
        cases: [{ caseId: 'c', imageName: 'a', referenceClass: 2 }],
      })
    ).toThrow();
  });

  it('honors an explicit groundTruthAvailable=false even when a reference exists', () => {
    const ds = parseDatasetManifest({
      ...seg,
      cases: [{ caseId: 'c1', imageName: 'a.nii', referenceLabelName: 'a_seg.nii', groundTruthAvailable: false }],
    });
    expect(ds.cases[0]!.groundTruthAvailable).toBe(false);
  });
});

describe('datasetCompleteness', () => {
  it('reports scorable fraction', () => {
    const ds = parseDatasetManifest(seg);
    expect(datasetCompleteness(ds)).toEqual({ totalCases: 2, withGroundTruth: 1, completeness: 0.5 });
  });
});
