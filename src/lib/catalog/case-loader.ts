/**
 * Load a benchmark case into the viewer + a ground-truth reference in the
 * catalogue label space (1 liver, 2 tumour) on the CT grid.
 *  - IDC (TCIA) cases: CT series (annotated acquisition only) + DICOM-SEG.
 *  - Local NIfTI cases: CT + label map (MSD convention 1 liver, 2 tumour).
 */
import type { ViewerHandle } from '../../components/Viewer';
import type { VolumeMetadata, Bytes } from '../../types';
import { asBytes } from '../../types';
import type { IdcCase } from './catalog';
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
  onProgress?: (msg: string) => void
): Promise<LoadedCase> {
  onProgress?.('Listing CT series on IDC…');
  const all = await fetchIdcSeriesFiles(c.ctSeriesUuid, {
    list: (u) => listIdcSeriesUrls(u),
    fetchAsset: (u) => fetchCatalogAsset(u),
    concurrency: 8,
    onProgress: (d, t) => onProgress?.(`CT ${d}/${t} slices`),
  });
  const files = filterByAcquisition(all, c.acquisitionNumber, readAcquisitionNumber);
  onProgress?.('Building volume…');
  const loaded = await viewer.loadPrimaryFromFiles(files);
  const meta = loaded.meta;
  onProgress?.('Fetching ground-truth DICOM-SEG…');
  const segFiles = await fetchIdcSeriesFiles(c.segSeriesUuid, {
    list: (u) => listIdcSeriesUrls(u),
    fetchAsset: (u) => fetchCatalogAsset(u),
  });
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

/** Local NIfTI case: CT + label map on the same grid (1 liver, 2 tumour; other labels ignored). */
export async function loadLocalNiftiCase(viewer: ViewerHandle, ct: File, label: File): Promise<LoadedCase> {
  const ctBytes = asBytes(new Uint8Array(await ct.arrayBuffer()));
  const lbBytes = new Uint8Array(await label.arrayBuffer());
  const loaded = await viewer.loadPrimary(ct.name, ctBytes);
  const lb = await readNiftiVolume(lbBytes, label.name);
  const [a, b, c] = lb.dims;
  if (a !== loaded.meta.dims[0] || b !== loaded.meta.dims[1] || c !== loaded.meta.dims[2]) {
    throw new Error(`Label map ${lb.dims.join('×')} does not match CT ${loaded.meta.dims.join('×')}.`);
  }
  const mask = new Uint8Array(lb.voxels.length);
  for (let i = 0; i < mask.length; i++) {
    const v = Math.round(Number(lb.voxels[i]));
    mask[i] = v === 1 || v === 2 ? v : 0;
  }
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
