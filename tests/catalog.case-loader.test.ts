import { describe, expect, it } from 'vitest';
import { loadLocalNiftiCase, remapGtLabels } from '../src/lib/catalog/case-loader';
import { CATALOG_DATASETS } from '../src/lib/catalog/catalog';

const ds = (id: string) => CATALOG_DATASETS.find((d) => d.id === id)!;

/** Minimal uint8 NIfTI-1 (single file, no scaling). */
function uint8Nifti(values: number[], dims: [number, number, number]): Uint8Array {
  const off = 352;
  const buf = new Uint8Array(off + values.length);
  const v = new DataView(buf.buffer);
  v.setInt16(0, 348, true);
  v.setInt16(40, 3, true);
  v.setInt16(42, dims[0], true);
  v.setInt16(44, dims[1], true);
  v.setInt16(46, dims[2], true);
  v.setInt16(70, 2, true);
  v.setInt16(72, 8, true);
  v.setFloat32(80, 1, true);
  v.setFloat32(84, 1, true);
  v.setFloat32(88, 1, true);
  v.setFloat32(108, off, true);
  buf.set([0x6e, 0x2b, 0x31, 0x00], 344);
  buf.set(values, off);
  return buf;
}

describe('catalogue ground-truth label maps', () => {
  it('declares the native liver/tumour labels per dataset', () => {
    expect(ds('btcv').gtLabels).toEqual({ liver: [6], tumour: [] });
    expect(ds('msd-task03-liver').gtLabels).toEqual({ liver: [1], tumour: [2] });
    expect(ds('hcc-tace-seg').gtLabels).toEqual({ liver: [1], tumour: [2] });
  });

  it('remaps BTCV (6 = liver; 1 spleen, 2 right kidney) to canonical 1/2', () => {
    const m = remapGtLabels([0, 1, 2, 6, 6, 8], ds('btcv').gtLabels);
    expect(Array.from(m)).toEqual([0, 0, 0, 1, 1, 0]);
  });

  it('keeps MSD liver/tumour and drops anything else', () => {
    const m = remapGtLabels(Float32Array.from([0, 1, 2, 3, 1.0000001]), ds('msd-task03-liver').gtLabels);
    expect(Array.from(m)).toEqual([0, 1, 2, 0, 1]);
  });

  it('loadLocalNiftiCase applies the dataset label map', async () => {
    const dims: [number, number, number] = [2, 2, 1];
    const viewer = {
      loadPrimary: async () => ({
        voxels: new Int16Array(4),
        meta: { dims, spacing: [1, 1, 1] as [number, number, number], origin: [0, 0, 0] as [number, number, number] },
      }),
    } as unknown as Parameters<typeof loadLocalNiftiCase>[0];
    const ct = new File([uint8Nifti([0, 0, 0, 0], dims)], 'img_0001.nii');
    const label = new File([uint8Nifti([1, 2, 6, 0], dims)], 'label_0001.nii');
    const lc = await loadLocalNiftiCase(viewer, ct, label, ds('btcv'));
    expect(Array.from(lc.reference.mask)).toEqual([0, 0, 1, 0]);
    const lcMsd = await loadLocalNiftiCase(viewer, ct, label, ds('msd-task03-liver'));
    expect(Array.from(lcMsd.reference.mask)).toEqual([1, 2, 0, 0]);
  });
});
