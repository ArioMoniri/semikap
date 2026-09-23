import { pairModelFiles } from '../src/lib/catalog/local-models';
import { pairLocalFiles } from '../src/lib/catalog/case-loader';
import { describe, expect, it } from 'vitest';
import { BENCHMARK_KITS } from '../src/lib/catalog/kits';
import { CATALOG_DATASETS, CATALOG_MODELS } from '../src/lib/catalog/catalog';
import { makeZip } from '../src/lib/fs/zip';
import { unzipSync, strFromU8 } from 'fflate';

describe('benchmark kits', () => {
  it('every kit references catalogue datasets, cases and Zenodo models only', () => {
    expect(BENCHMARK_KITS.length).toBeGreaterThanOrEqual(3);
    for (const k of BENCHMARK_KITS) {
      const ds = CATALOG_DATASETS.find((d) => d.id === k.datasetId);
      expect(ds, k.id).toBeDefined();
      for (const m of k.modelIds) expect(CATALOG_MODELS.some((x) => x.id === m), m).toBe(true);
      if (ds!.access.kind === 'idc-s3') {
        const ids = ds!.access.cases.map((c) => c.caseId);
        for (const c of k.caseIds ?? []) expect(ids).toContain(c);
      }
    }
  });
  it('includes the full 10-model × HCC-TACE-Seg external benchmark', () => {
    const k = BENCHMARK_KITS.find((x) => x.id === 'hcc-all-models')!;
    expect(k.modelIds).toHaveLength(10);
    expect(k.caseIds).toHaveLength(10);
  });
});

describe('makeZip (stored)', () => {
  it('round-trips files through a standard unzip', () => {
    const z = makeZip({ 'REPORT.md': '# hi\n', 'a/b.csv': 'x,y\n1,2\n' });
    const out = unzipSync(z);
    expect(strFromU8(out['REPORT.md']!)).toBe('# hi\n');
    expect(strFromU8(out['a/b.csv']!)).toBe('x,y\n1,2\n');
  });
});

describe('pairLocalFiles', () => {
  it('pairs MSD imagesTr/labelsTr and *_label / _0000 naming by stem', () => {
    const f = (n: string) => ({ name: n }) as File;
    const pairs = pairLocalFiles(
      [f('liver_1.nii.gz'), f('liver_22_0000.nii.gz'), f('orphan.nii.gz')],
      [f('liver_1.nii.gz'), f('liver_22_label.nii.gz')]
    );
    expect(pairs.map((p) => `${p.caseId}:${p.ct.name}:${p.label.name}`)).toEqual([
      'liver_1:liver_1.nii.gz:liver_1.nii.gz',
      'liver_22:liver_22_0000.nii.gz:liver_22_label.nii.gz',
    ]);
  });
});

describe('pairModelFiles', () => {
  it('pairs release assets by basename and ignores non-catalogue files', () => {
    const f = (n: string) => ({ name: n });
    const p = pairModelFiles([f('lms3d_unet.onnx'), f('lms3d_unet.json'), f('evil.onnx'), f('evil.json'), f('nnunet_liver_lits.json')]);
    expect(p.map((x) => x.id)).toEqual(['lms3d_unet']);
  });
});
