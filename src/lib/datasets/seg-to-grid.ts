/**
 * Geometry-aware DICOM-SEG → target-grid mapping.
 *
 * `readDicomSeg` stacks frames by their DimensionIndexValues, which is only
 * right when the SEG has one frame per CT slice. Real TCIA SEGs (e.g.
 * HCC-TACE-Seg) are *sparse* — frames exist only where a segment is present
 * — so the frame index is not the CT slice index. Here every frame is placed
 * by its ImagePositionPatient / ImageOrientationPatient / PixelSpacing into
 * the loaded CT's voxel grid (NIfTI RAS affine from the viewer), which is
 * exact for any slice ordering, sparse frames, or overlapping segments.
 */

import * as dcmjsDefault from 'dcmjs';

export interface GridAffine {
  dims: [number, number, number];
  /** voxel → RAS rows (NIfTI sform). */
  srowX: [number, number, number, number];
  srowY: [number, number, number, number];
  srowZ: [number, number, number, number];
}

export interface SegFrameGeom {
  segment: number;
  /** ImagePositionPatient (LPS, mm). */
  ipp: [number, number, number];
  /** rows*columns, 0/1 per pixel, row-major. */
  pixels: Uint8Array;
}

export interface SegGeom {
  rows: number;
  columns: number;
  /** ImageOrientationPatient: row direction (3) then column direction (3). */
  iop: [number, number, number, number, number, number];
  /** PixelSpacing: [between rows, between columns]. */
  pixelSpacing: [number, number];
  frames: SegFrameGeom[];
}

export interface MappedSeg {
  mask: Uint8Array;
  dims: [number, number, number];
  outOfGridFrames: number;
}

function invert3x4(g: GridAffine): (p: [number, number, number]) => [number, number, number] {
  const a = [g.srowX, g.srowY, g.srowZ];
  const m = a.map((r) => [r[0], r[1], r[2]]);
  const t = a.map((r) => r[3]);
  const det =
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  if (Math.abs(det) < 1e-12) throw new Error('Target grid affine is singular.');
  const c = (r: number, col: number) => m[r]![col]!;
  const inv = [
    [
      (c(1, 1) * c(2, 2) - c(1, 2) * c(2, 1)) / det,
      (c(0, 2) * c(2, 1) - c(0, 1) * c(2, 2)) / det,
      (c(0, 1) * c(1, 2) - c(0, 2) * c(1, 1)) / det,
    ],
    [
      (c(1, 2) * c(2, 0) - c(1, 0) * c(2, 2)) / det,
      (c(0, 0) * c(2, 2) - c(0, 2) * c(2, 0)) / det,
      (c(0, 2) * c(1, 0) - c(0, 0) * c(1, 2)) / det,
    ],
    [
      (c(1, 0) * c(2, 1) - c(1, 1) * c(2, 0)) / det,
      (c(0, 1) * c(2, 0) - c(0, 0) * c(2, 1)) / det,
      (c(0, 0) * c(1, 1) - c(0, 1) * c(1, 0)) / det,
    ],
  ];
  return (p) => {
    const d = [p[0] - t[0]!, p[1] - t[1]!, p[2] - t[2]!];
    return [0, 1, 2].map((r) => inv[r]![0]! * d[0]! + inv[r]![1]! * d[1]! + inv[r]![2]! * d[2]!) as [
      number,
      number,
      number,
    ];
  };
}

const lpsToRas = (p: [number, number, number]): [number, number, number] => [-p[0], -p[1], p[2]];

/**
 * Map SEG frames into the target grid. `labelOf(segmentNumber)` returns the
 * output label (0 drops the segment). Higher labels win on overlap, so
 * tumour (2) paints over liver (1).
 */
export function mapSegFramesToGrid(seg: SegGeom, grid: GridAffine, labelOf: (segment: number) => number): MappedSeg {
  const [nx, ny, nz] = grid.dims;
  const mask = new Uint8Array(nx * ny * nz);
  const toVoxel = invert3x4(grid);
  const rowDir = seg.iop.slice(0, 3) as [number, number, number];
  const colDir = seg.iop.slice(3, 6) as [number, number, number];
  const [dr, dc] = seg.pixelSpacing;
  let outOfGridFrames = 0;
  for (const f of seg.frames) {
    const label = labelOf(f.segment);
    if (!label) continue;
    // voxel coords are affine in (c, r): v = v0 + c*vc + r*vr
    const v0 = toVoxel(lpsToRas(f.ipp));
    const pc = lpsToRas([f.ipp[0] + rowDir[0] * dc, f.ipp[1] + rowDir[1] * dc, f.ipp[2] + rowDir[2] * dc]);
    const pr = lpsToRas([f.ipp[0] + colDir[0] * dr, f.ipp[1] + colDir[1] * dr, f.ipp[2] + colDir[2] * dr]);
    const v1 = toVoxel(pc);
    const v2 = toVoxel(pr);
    const vc = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const vr = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    let hit = false;
    for (let r = 0; r < seg.rows; r++) {
      for (let c = 0; c < seg.columns; c++) {
        const i = Math.round(v0[0] + c * vc[0]! + r * vr[0]!);
        const j = Math.round(v0[1] + c * vc[1]! + r * vr[1]!);
        const k = Math.round(v0[2] + c * vc[2]! + r * vr[2]!);
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
        hit = true;
        if (!f.pixels[r * seg.columns + c]) continue;
        const idx = i + nx * (j + ny * k);
        if (label > mask[idx]!) mask[idx] = label;
      }
    }
    if (!hit) outOfGridFrames++;
  }
  return { mask, dims: [nx, ny, nz], outOfGridFrames };
}

/** Segment description → catalogue label (1 liver, 2 tumour, 0 ignore). */
export function classifySegment(description: string): number {
  const d = description.toLowerCase();
  // Word-anchored; lesion terms win over vessel terms, so e.g. "portal vein tumour
  // thrombus" counts as tumour (macrovascular invasion is part of the tumour burden).
  if (/\b(tumou?rs?|mass(es)?|lesions?|neoplasms?|carcinoma|hcc|metasta\w*)\b/.test(d)) return 2;
  if (/\b(veins?|vessels?|arter\w*|aorta|portal|ivc|cava)\b/.test(d)) return 0;
  if (/\bliver\b/.test(d)) return 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* dcmjs extraction                                                    */
/* ------------------------------------------------------------------ */

interface DcmjsRead {
  data: {
    DicomMessage: { readFile(buffer: ArrayBuffer): { dict: Record<string, unknown> } };
    DicomMetaDictionary: { naturalizeDataset(dataset: Record<string, unknown>): Record<string, unknown> };
  };
}
const dcmjs = dcmjsDefault as unknown as DcmjsRead;

function arr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}
function nums(v: unknown): number[] {
  return arr(v).map((x) => Number(x));
}

export interface ParsedSeg extends SegGeom {
  /** segment number → description (SegmentLabel / property type). */
  segments: Map<number, string>;
}

/** Parse a DICOM-SEG (BINARY or FRACTIONAL) into frames with geometry. */
export function parseDicomSegGeometry(bytes: Uint8Array): ParsedSeg {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(buf).dict);
  if (ds.Modality !== 'SEG') throw new Error(`DICOM Modality is "${String(ds.Modality)}", expected "SEG".`);
  const rows = Number(ds.Rows);
  const columns = Number(ds.Columns);
  const n = Number(ds.NumberOfFrames);
  const bits = Number(ds.BitsAllocated ?? 1);
  // FRACTIONAL SEG: occupancy/probability scaled to MaximumFractionalValue (default 255).
  const fracThreshold = Number(ds.MaximumFractionalValue ?? 255) / 2;
  const pd = arr(ds.PixelData)[0];
  const pixelData = pd instanceof ArrayBuffer ? new Uint8Array(pd) : pd instanceof Uint8Array ? pd : null;
  if (!rows || !columns || !n || !pixelData) throw new Error('DICOM-SEG missing Rows/Columns/NumberOfFrames/PixelData.');

  const shared = arr(ds.SharedFunctionalGroupsSequence)[0] as Record<string, unknown> | undefined;
  const sharedPlane = arr(shared?.PlaneOrientationSequence)[0] as Record<string, unknown> | undefined;
  const sharedMeasures = arr(shared?.PixelMeasuresSequence)[0] as Record<string, unknown> | undefined;
  const perFrame = arr(ds.PerFrameFunctionalGroupsSequence) as Array<Record<string, unknown>>;

  const segments = new Map<number, string>();
  for (const s of arr(ds.SegmentSequence) as Array<Record<string, unknown>>) {
    const type = arr(s.SegmentedPropertyTypeCodeSequence)[0] as Record<string, unknown> | undefined;
    segments.set(Number(s.SegmentNumber), `${String(s.SegmentLabel ?? '')} ${String(type?.CodeMeaning ?? '')}`.trim());
  }

  const px = rows * columns;
  let iop: number[] | null = null;
  let spacing: number[] | null = null;
  const frames: SegFrameGeom[] = [];
  for (let f = 0; f < n; f++) {
    const fg = perFrame[f] ?? {};
    const plane = arr(fg.PlaneOrientationSequence)[0] as Record<string, unknown> | undefined;
    const meas = arr(fg.PixelMeasuresSequence)[0] as Record<string, unknown> | undefined;
    iop ??= nums((plane ?? sharedPlane)?.ImageOrientationPatient);
    spacing ??= nums((meas ?? sharedMeasures)?.PixelSpacing);
    const pos = arr(fg.PlanePositionSequence)[0] as Record<string, unknown> | undefined;
    const ipp = nums(pos?.ImagePositionPatient);
    const segId = arr(fg.SegmentIdentificationSequence)[0] as Record<string, unknown> | undefined;
    if (ipp.length !== 3) throw new Error(`SEG frame ${f + 1} has no ImagePositionPatient.`);
    const pixels = new Uint8Array(px);
    for (let p = 0; p < px; p++) {
      if (bits === 1) {
        const b = f * px + p;
        pixels[p] = ((pixelData[b >> 3] ?? 0) >> (b & 7)) & 1;
      } else {
        pixels[p] = (pixelData[f * px + p] ?? 0) > fracThreshold ? 1 : 0;
      }
    }
    frames.push({ segment: Number(segId?.ReferencedSegmentNumber ?? 1), ipp: ipp as [number, number, number], pixels });
  }
  if (!iop || iop.length !== 6) throw new Error('SEG has no ImageOrientationPatient.');
  if (!spacing || spacing.length !== 2) throw new Error('SEG has no PixelSpacing.');
  return {
    rows,
    columns,
    iop: iop as SegGeom['iop'],
    pixelSpacing: spacing as [number, number],
    frames,
    segments,
  };
}
