/**
 * RTSTRUCT reference import (doc §4.4).
 *
 * An RT Structure Set stores ROI contours as polylines in patient (mm)
 * coordinates. To score them we map each contour point to voxel indices using
 * the reference volume geometry (origin + spacing) and rasterize the polygon
 * per slice, labelling voxels by ROI number.
 *
 * IMPORTANT: the patient→voxel mapping here assumes an **axial, axis-aligned**
 * grid (the common case). Oblique acquisitions are not handled. The mapping and
 * rasterization cores (`patientToVoxel`, `rasterizeContours`) are pure and
 * unit-tested; the dcmjs parse (`readRtStruct`) is a thin wrapper.
 */

import * as dcmjsDefault from 'dcmjs';
import { patientToVoxel, rasterizeContours, type Grid, type VoxelContour, type ImportedMask } from './dicom-reconstruct';

export type { Grid, VoxelContour, ImportedMask } from './dicom-reconstruct';
export { patientToVoxel, rasterizeContours } from './dicom-reconstruct';

interface DcmjsRead {
  data: {
    DicomMessage: { readFile(buffer: ArrayBuffer): { dict: Record<string, unknown> } };
    DicomMetaDictionary: { naturalizeDataset(dataset: Record<string, unknown>): Record<string, unknown> };
  };
}
const dcmjs = dcmjsDefault as unknown as DcmjsRead;

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse an RTSTRUCT file to a label mask onto `grid`. Throws with a clear reason.
 * Labels are the ROI numbers from ROIContourSequence order (1-based).
 */
export function readRtStruct(bytes: Uint8Array, grid: Grid): ImportedMask {
  let ds: Record<string, unknown>;
  try {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const parsed = dcmjs.data.DicomMessage.readFile(buf);
    ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(parsed.dict);
  } catch (e) {
    throw new Error(`Not a valid DICOM file (${(e as Error).message}).`);
  }
  if (ds.Modality !== 'RTSTRUCT') {
    throw new Error(`DICOM Modality is "${String(ds.Modality)}", expected "RTSTRUCT".`);
  }
  const roiContours = asArray(ds.ROIContourSequence);
  if (roiContours.length === 0) throw new Error('RTSTRUCT has no ROIContourSequence.');

  const contours: VoxelContour[] = [];
  roiContours.forEach((roiRaw, roiIdx) => {
    const roi = roiRaw as Record<string, unknown>;
    const label = num((roi.ReferencedROINumber as number | undefined) ?? roiIdx + 1, roiIdx + 1);
    for (const cRaw of asArray(roi.ContourSequence)) {
      const c = cRaw as Record<string, unknown>;
      const data = asArray(c.ContourData).map((n) => num(n));
      if (data.length < 9) continue; // need ≥3 points
      const pts: [number, number][] = [];
      let z = 0;
      for (let i = 0; i + 2 < data.length; i += 3) {
        const v = patientToVoxel([data[i]!, data[i + 1]!, data[i + 2]!], grid);
        pts.push([v.x, v.y]);
        z = v.z;
      }
      contours.push({ z, label, points: pts });
    }
  });
  return { mask: rasterizeContours(contours, grid.dims), dims: grid.dims };
}
