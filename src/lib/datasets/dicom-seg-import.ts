/**
 * DICOM-SEG reference import (doc §4.4).
 *
 * A DICOM Segmentation object is self-geometric: it carries Rows/Columns/frames
 * and its own bit-packed (BINARY) or 8-bit (FRACTIONAL) pixel data. We
 * reconstruct a linearized label volume (label = segment number) that the
 * benchmark engine can score against a model output.
 *
 * The reconstruction core (`reconstructSegVolume`) is pure and unit-tested on
 * synthetic frames — it is the algorithmically load-bearing part. The dcmjs
 * parse/extraction (`readDicomSeg`) is a thin best-effort wrapper; per-frame
 * z-ordering follows DimensionIndexValues when present, else frame order.
 */

import * as dcmjsDefault from 'dcmjs';
import { reconstructSegVolume, type SegFrame, type ImportedMask } from './dicom-reconstruct';

export type { ImportedMask, SegFrame, SegSource } from './dicom-reconstruct';
export { reconstructSegVolume } from './dicom-reconstruct';

interface DcmjsRead {
  data: {
    DicomMessage: { readFile(buffer: ArrayBuffer): { dict: Record<string, unknown> } };
    DicomMetaDictionary: { naturalizeDataset(dataset: Record<string, unknown>): Record<string, unknown> };
  };
}
const dcmjs = dcmjsDefault as unknown as DcmjsRead;

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a DICOM-SEG file to a label mask. Throws with a clear reason on failure. */
export function readDicomSeg(bytes: Uint8Array): ImportedMask {
  let ds: Record<string, unknown>;
  try {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const parsed = dcmjs.data.DicomMessage.readFile(buf);
    ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(parsed.dict);
  } catch (e) {
    throw new Error(`Not a valid DICOM file (${(e as Error).message}).`);
  }
  if (ds.Modality !== 'SEG') {
    throw new Error(`DICOM Modality is "${String(ds.Modality)}", expected "SEG".`);
  }
  const rows = num(ds.Rows);
  const columns = num(ds.Columns);
  const numberOfFrames = num(ds.NumberOfFrames);
  const bitsAllocated = num(ds.BitsAllocated, 1);
  const pixelRaw = ds.PixelData;
  const pixelData = toUint8(pixelRaw);
  if (!rows || !columns || !numberOfFrames || !pixelData) {
    throw new Error('DICOM-SEG missing Rows/Columns/NumberOfFrames/PixelData.');
  }

  // Per-frame segment + z. DimensionIndexValues' last element is the in-stack
  // position (1-based) when present; otherwise fall back to frame order.
  const perFrame = asArray(ds.PerFrameFunctionalGroupsSequence);
  const frames: SegFrame[] = [];
  let maxZ = 0;
  for (let i = 0; i < numberOfFrames; i++) {
    const fg = perFrame[i] as Record<string, unknown> | undefined;
    const segId = fg ? asArray(fg.SegmentIdentificationSequence)[0] as Record<string, unknown> | undefined : undefined;
    const segment = segId ? num(segId.ReferencedSegmentNumber, 1) : 1;
    const content = fg ? (asArray(fg.FrameContentSequence)[0] as Record<string, unknown> | undefined) : undefined;
    const div = content ? asArray(content.DimensionIndexValues) : [];
    const z = div.length > 0 ? num(div[div.length - 1], i + 1) - 1 : i;
    frames.push({ segment, z });
    if (z > maxZ) maxZ = z;
  }
  const depth = Math.max(maxZ + 1, 1);
  return reconstructSegVolume({ rows, columns, depth, bitsAllocated, pixelData, frames });
}

function toUint8(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v) && v[0] instanceof ArrayBuffer) return new Uint8Array(v[0] as ArrayBuffer);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}
