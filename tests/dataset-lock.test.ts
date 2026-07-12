import { describe, expect, it } from 'vitest';
import type { DatasetManifest } from '../src/lib/datasets/manifest';
import { computeDatasetLock, verifyDatasetLock } from '../src/lib/datasets/lock';

/** Manifest with cases deliberately out of caseId order (b2 before a1). */
function makeDataset(): DatasetManifest {
  return {
    schema: 'tamias.dataset.v1',
    name: 'demo',
    task: 'segmentation',
    cases: [
      {
        caseId: 'b2',
        imageName: 'b.nii',
        groundTruthAvailable: false,
      },
      {
        caseId: 'a1',
        imageName: 'a.nii',
        referenceLabelName: 'a_seg.nii',
        groundTruthAvailable: true,
      },
    ],
  };
}

const HASHES: Record<string, string> = {
  'a.nii': 'aaa',
  'a_seg.nii': 'seg',
  'b.nii': 'bbb',
};

// Canonical JSON (caseId-sorted): [["a1","a.nii","a_seg.nii","aaa","seg"],["b2","b.nii","","bbb",""]]
const EXPECTED_FINGERPRINT =
  '22f3ffa70ffc05b668eac0995b54c3fd11ccaaef9fc484d732abce50dbd6f7d6';

describe('computeDatasetLock', () => {
  it('produces the hand-computed SHA-256 fingerprint and lock shape', async () => {
    const lock = await computeDatasetLock(makeDataset(), HASHES, '2026-07-12T00:00:00Z');
    expect(lock).toEqual({
      schema: 'tamias.datasetlock.v1',
      datasetName: 'demo',
      caseCount: 2,
      fingerprint: EXPECTED_FINGERPRINT,
      lockedAt: '2026-07-12T00:00:00Z',
    });
  });

  it('is order-independent: reordered cases yield the same fingerprint', async () => {
    const ds = makeDataset();
    const reordered: DatasetManifest = { ...ds, cases: [ds.cases[1]!, ds.cases[0]!] };
    const a = await computeDatasetLock(ds, HASHES, 't1');
    const b = await computeDatasetLock(reordered, HASHES, 't2');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toBe(EXPECTED_FINGERPRINT);
  });
});

describe('verifyDatasetLock', () => {
  it('verifies true for identical inputs', async () => {
    const ds = makeDataset();
    const lock = await computeDatasetLock(ds, HASHES, 'now');
    expect(await verifyDatasetLock(ds, HASHES, lock)).toBe(true);
  });

  it('verifies false when a file hash changes', async () => {
    const ds = makeDataset();
    const lock = await computeDatasetLock(ds, HASHES, 'now');
    const tampered: Record<string, string> = { ...HASHES, 'a.nii': 'zzz' };
    expect(tampered['a.nii']).not.toBe(HASHES['a.nii']);
    expect(await verifyDatasetLock(ds, tampered, lock)).toBe(false);
  });

  it('verifies false when the case count changes', async () => {
    const ds = makeDataset();
    const lock = await computeDatasetLock(ds, HASHES, 'now');
    const fewer: DatasetManifest = { ...ds, cases: [ds.cases[0]!] };
    expect(await verifyDatasetLock(fewer, HASHES, lock)).toBe(false);
  });
});
