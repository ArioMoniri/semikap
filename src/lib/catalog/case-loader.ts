/**
 * Load a benchmark case into the viewer + a ground-truth reference in the
 * catalogue label space (1 liver, 2 tumour) on the CT grid.
 *  - IDC (TCIA) cases: CT series (annotated acquisition only) + DICOM-SEG.
 *  - Local NIfTI cases: CT + label map in the dataset's own label values
 *    (CatalogDataset.gtLabels, e.g. BTCV 6 = liver), remapped to 1/2.
 */
import type { ViewerHandle } from '../../components/Viewer';
import type { VolumeMetadata, Bytes } from '../../types';
import { asBytes } from '../../types';
import type { CatalogDataset, IdcCase } from './catalog';
import { fetchCatalogAsset } from './fetch';
import { listIdcSeriesUrls, readAcquisitionNumber } from './idc';
import { fetchIdcSeriesFiles, filterByAcquisition } from './load';
import { parseDicomSegGeometry, mapSegFramesToGrid, classifySegment } from '../datasets/seg-to-grid';
import { readNiftiVolume } from '../datasets/nifti-volume';

export interface LoadedCase {
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  meta: VolumeMetadata;
  firstFile: { name: string; bytes: Bytes };
  reference: { mask: Uint8Array; dims: [number, number, number]; spacing: [number, number, number] };
  note: string;
}

export async function loadIdcCase(
  viewer: ViewerHandle,
  c: IdcCase,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<LoadedCase> {
  const list = (u: string) => listIdcSeriesUrls(u, (url, init) => fetch(url, { ...init, signal }));
  const fetchAsset = (u: string) => fetchCatalogAsset(u, { signal });
  onProgress?.('Listing CT series on IDC…');
  const all = await fetchIdcSeriesFiles(c.ctSeriesUuid, {
    list,
    fetchAsset,
    signal,
    concurrency: 8,
    onProgress: (d, t) => onProgress?.(`CT ${d}/${t} slices`),
  });
  const files = filterByAcquisition(all, c.acquisitionNumber, readAcquisitionNumber);
  onProgress?.('Building volume…');
  const loaded = await viewer.loadPrimaryFromFiles(files);
  const meta = loaded.meta;
  onProgress?.('Fetching ground-truth DICOM-SEG…');
  const segFiles = await fetchIdcSeriesFiles(c.segSeriesUuid, { list, fetchAsset, signal });
  const seg = parseDicomSegGeometry(segFiles[0]!.bytes);
  if (!meta.srowX || !meta.srowY || !meta.srowZ) throw new Error('Viewer did not expose the CT affine; cannot place the ground truth.');
  const mapped = mapSegFramesToGrid(
    seg,
    { dims: meta.dims, srowX: meta.srowX, srowY: meta.srowY, srowZ: meta.srowZ },
    (s) => classifySegment(seg.segments.get(s) ?? '')
  );
  return {
    voxels: loaded.voxels,
    meta,
    firstFile: files[0]!,
    reference: { mask: mapped.mask, dims: mapped.dims, spacing: meta.spacing },
    note:
      `${files.length} CT slices + GT (${[...seg.segments.values()].join(', ')})` +
      (mapped.outOfGridFrames ? ` — ${mapped.outOfGridFrames} SEG frames outside the CT grid` : ''),
  };
}

/**
 * Remap a dataset label map to the canonical catalogue label space
 * (1 liver, 2 tumour, 0 everything else) using the dataset's own label values.
 */
export function remapGtLabels(
  voxels: ArrayLike<number>,
  gt: CatalogDataset['gtLabels']
): Uint8Array {
  const lut = new Map<number, number>();
  for (const v of gt.liver) lut.set(v, 1);
  for (const v of gt.tumour) lut.set(v, 2);
  const mask = new Uint8Array(voxels.length);
  for (let i = 0; i < mask.length; i++) mask[i] = lut.get(Math.round(Number(voxels[i]))) ?? 0;
  return mask;
}

/**
 * Local NIfTI case: CT + label map on the same grid. The label map is in the
 * dataset's native label values (`dataset.gtLabels`) and is remapped to the
 * canonical 1 liver / 2 tumour; other labels are ignored.
 */
export async function loadLocalNiftiCase(
  viewer: Pick<ViewerHandle, 'loadPrimary'>,
  ct: File,
  label: File,
  dataset: Pick<CatalogDataset, 'gtLabels'>
): Promise<LoadedCase> {
  const ctBytes = asBytes(new Uint8Array(await ct.arrayBuffer()));
  const lbBytes = new Uint8Array(await label.arrayBuffer());
  const loaded = await viewer.loadPrimary(ct.name, ctBytes);
  const lb = await readNiftiVolume(lbBytes, label.name);
  const [a, b, c] = lb.dims;
  if (a !== loaded.meta.dims[0] || b !== loaded.meta.dims[1] || c !== loaded.meta.dims[2]) {
    throw new Error(`Label map ${lb.dims.join('×')} does not match CT ${loaded.meta.dims.join('×')}.`);
  }
  const mask = remapGtLabels(lb.voxels, dataset.gtLabels);
  return {
    voxels: loaded.voxels,
    meta: loaded.meta,
    firstFile: { name: ct.name, bytes: ctBytes },
    reference: { mask, dims: lb.dims, spacing: loaded.meta.spacing },
    note: `local NIfTI ${ct.name} + ${label.name}`,
  };
}

/** Pair CT and label files by stem (liver_1.nii.gz ↔ liver_1.nii.gz / liver_1_label… / labelsTr). */
export function pairLocalFiles(cts: File[], labels: File[]): Array<{ caseId: string; ct: File; label: File }> {
  const stem = (n: string) =>
    n
      .replace(/\.nii(\.gz)?$/i, '')
      .replace(/[_-]?(label|labels|seg|gt|mask)$/i, '')
      .replace(/_0000$/, '');
  const byStem = new Map(labels.map((f) => [stem(f.name), f]));
  return cts
    .map((ct) => ({ caseId: stem(ct.name), ct, label: byStem.get(stem(ct.name)) }))
    .filter((p): p is { caseId: string; ct: File; label: File } => !!p.label);
}
