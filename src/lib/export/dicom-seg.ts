/**
 * DICOM Segmentation IOD writer.
 *
 * Produces a DICOM-SEG instance from:
 *   - the original DICOM bytes the user loaded as the primary volume
 *   - the AI label mask (per-voxel index, in source-volume order)
 *   - the model manifest (segment names + colours)
 *
 * Built on top of dcmjs's derivations. The output references the source's
 * StudyInstanceUID / SeriesInstanceUID / FrameOfReferenceUID so the SEG can
 * be sent back to a PACS that holds the original imaging.
 *
 * Limitations:
 *   - Phase 1 supports a single-file source DICOM only (single-frame or
 *     multi-frame). DICOM file-set series sourced from a directory will be
 *     supported in Phase 5 once we add multi-file ingest.
 *   - We re-pack the label map as a binary segmentation (one frame per
 *     non-background label, per slice) — robust but verbose. Compression is
 *     not applied; SEGs from this writer are typically a few MB.
 */

import * as dcmjsDefault from 'dcmjs';
import type { Bytes, ModelManifest } from '../../types';
import { asBytes } from '../../types';

// dcmjs ships as a default export with several namespaced sub-packages.
// We narrow the surface we touch to a typed shape.
interface DcmjsLike {
  data: {
    DicomMessage: {
      readFile(buffer: ArrayBuffer): {
        dict: Record<string, unknown>;
        write(): ArrayBuffer;
        meta: Record<string, unknown>;
      };
    };
    DicomMetaDictionary: {
      naturalizeDataset(dataset: Record<string, unknown>): Record<string, unknown>;
      denaturalizeDataset(dataset: Record<string, unknown>): Record<string, unknown>;
      uid(): string;
    };
  };
  derivations: {
    Segmentation: new (
      referenceDatasets: Array<Record<string, unknown>>,
      options?: Record<string, unknown>
    ) => {
      dataset: Record<string, unknown>;
    };
  };
}

const dcmjs = dcmjsDefault as unknown as DcmjsLike;

export interface DicomSegInputs {
  /** Bytes of the source DICOM the user loaded as primary. */
  sourceDicomBytes: Bytes;
  /** Linearized label map matching the source volume's voxel grid. */
  mask: Uint8Array;
  /** Source-volume dimensions, [X, Y, Z]. */
  dims: [number, number, number];
  /** Manifest used for segment labels + colours. */
  manifest: ModelManifest;
  /** Series description shown in PACS. */
  seriesDescription?: string;
  /** Algorithm name + version for the SEG metadata. */
  algorithm?: { name: string; version: string };
}

/**
 * Build a DICOM-SEG byte array. Throws with a precise reason if the source
 * bytes are not a parseable DICOM dataset.
 */
export function writeDicomSeg(inputs: DicomSegInputs): Bytes {
  const { sourceDicomBytes, mask, dims, manifest } = inputs;
  const [nx, ny, nz] = dims;
  if (mask.length !== nx * ny * nz) {
    throw new Error(
      `DICOM-SEG: mask length ${mask.length} does not match dims ${nx}*${ny}*${nz}.`
    );
  }

  // Parse the source DICOM. dcmjs throws if this isn't a DICOM file (e.g. the
  // user loaded a NIfTI). Surface the failure with a clear message.
  let parsed: { dict: Record<string, unknown>; write(): ArrayBuffer; meta: Record<string, unknown> };
  try {
    const buf = sourceDicomBytes.buffer.slice(
      sourceDicomBytes.byteOffset,
      sourceDicomBytes.byteOffset + sourceDicomBytes.byteLength
    ) as ArrayBuffer;
    parsed = dcmjs.data.DicomMessage.readFile(buf);
  } catch (e) {
    throw new Error(
      `DICOM-SEG export failed: source file is not a valid DICOM dataset (${(e as Error).message}).`
    );
  }
  const referenceDataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(parsed.dict);

  // Build segment metadata from the manifest, skipping background (label 0).
  const segments = Object.entries(manifest.output.labels)
    .filter(([k]) => k !== '0')
    .map(([k, name]) => {
      const idx = Number(k);
      const cssColor = manifest.output.colors?.[idx] ?? '#22c55e';
      const rgb = hexToRgbTriplet(cssColor);
      return {
        labelmapIndex: idx,
        SegmentLabel: name,
        SegmentAlgorithmType: 'AUTOMATIC' as const,
        SegmentAlgorithmName: inputs.algorithm?.name ?? `TAMIAS:${manifest.name}`,
        SegmentNumber: idx,
        RecommendedDisplayCIELabValue: rgb,
        SegmentedPropertyCategoryCodeSequence: {
          CodeValue: '49755003',
          CodingSchemeDesignator: 'SCT',
          CodeMeaning: 'Morphologically Abnormal Structure',
        },
        SegmentedPropertyTypeCodeSequence: {
          CodeValue: '49755003',
          CodingSchemeDesignator: 'SCT',
          CodeMeaning: name,
        },
      };
    });

  if (segments.length === 0) {
    throw new Error('DICOM-SEG export failed: manifest has no foreground labels.');
  }

  // Segmentation derivation. Pass the original dataset as the reference so
  // PACS knows which series this SEG annotates.
  const seg = new dcmjs.derivations.Segmentation([referenceDataset], {
    SeriesDescription:
      inputs.seriesDescription ?? `TAMIAS ${manifest.name} v${manifest.version}`,
    SeriesNumber: '99',
  });

  // dcmjs's Segmentation derivation expects per-segment binary frames in a
  // PixelData buffer. We pack one bit per voxel per segment, slice-major.
  const pixelData = packBinarySegments(mask, dims, segments.map((s) => s.labelmapIndex));

  const ds = seg.dataset as Record<string, unknown>;
  ds.NumberOfFrames = String(nz * segments.length);
  ds.SegmentSequence = segments.map((s) => ({
    SegmentNumber: s.SegmentNumber,
    SegmentLabel: s.SegmentLabel,
    SegmentAlgorithmType: s.SegmentAlgorithmType,
    SegmentAlgorithmName: s.SegmentAlgorithmName,
    RecommendedDisplayCIELabValue: s.RecommendedDisplayCIELabValue,
    SegmentedPropertyCategoryCodeSequence: s.SegmentedPropertyCategoryCodeSequence,
    SegmentedPropertyTypeCodeSequence: s.SegmentedPropertyTypeCodeSequence,
  }));
  ds.PixelData = pixelData.buffer;
  ds.Rows = ny;
  ds.Columns = nx;
  ds.SegmentationType = 'BINARY';
  ds.BitsAllocated = 1;
  ds.BitsStored = 1;
  ds.HighBit = 0;
  ds.PixelRepresentation = 0;
  ds.SamplesPerPixel = 1;
  ds.PhotometricInterpretation = 'MONOCHROME2';

  // Re-write the dataset out as a DICOM byte stream.
  let out: ArrayBuffer;
  try {
    out = parsed.write();
  } catch (e) {
    throw new Error(`DICOM-SEG write failed: ${(e as Error).message}`);
  }
  return asBytes(new Uint8Array(out));
}

/**
 * Pack a label map into a 1-bit-per-voxel buffer, ordered as
 *   for segment in segments:
 *     for z in 0..Z:
 *       for y in 0..Y:
 *         for x in 0..X:
 *           bit = (mask[z,y,x] === segmentLabel) ? 1 : 0
 *
 * This matches the layout dcmjs's Segmentation derivation expects for
 * BINARY SegmentationType. The bit order within each byte is little-endian
 * (bit 0 = first voxel), which is what DICOM specifies.
 */
function packBinarySegments(
  mask: Uint8Array,
  dims: [number, number, number],
  labels: number[]
): Uint8Array {
  const [nx, ny, nz] = dims;
  const voxelsPerSegment = nx * ny * nz;
  const bytesPerSegment = Math.ceil(voxelsPerSegment / 8);
  const out = new Uint8Array(bytesPerSegment * labels.length);

  for (let s = 0; s < labels.length; s++) {
    const target = labels[s]!;
    const segOffset = s * bytesPerSegment;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const voxel = z * nx * ny + y * nx + x;
          if (mask[voxel] !== target) continue;
          const byte = segOffset + (voxel >> 3);
          const bit = voxel & 7;
          out[byte] = out[byte]! | (1 << bit);
        }
      }
    }
  }

  return out;
}

/** "#rrggbb" → [r, g, b] triplet (0..255). Falls back to mid-grey on parse failure. */
function hexToRgbTriplet(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
