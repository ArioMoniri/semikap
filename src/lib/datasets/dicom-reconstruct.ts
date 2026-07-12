/**
 * Pure reconstruction/rasterization cores for DICOM reference import (no dcmjs,
 * no DOM) so they can be unit-tested in isolation. The dcmjs-dependent parsers
 * (`dicom-seg-import.ts`, `rtstruct-import.ts`) call into these.
 */

import { rasterizePolygon, type Poly } from './rasterize';

export interface ImportedMask {
  mask: Uint8Array;
  dims: [number, number, number];
}

// --- DICOM-SEG volume reconstruction ---

export interface SegFrame {
  /** Segment number → becomes the voxel label. */
  segment: number;
  /** 0-based z-slice index this frame maps to. */
  z: number;
}

export interface SegSource {
  rows: number;
  columns: number;
  depth: number;
  /** 1 = BINARY (bit-packed), 8 = FRACTIONAL. */
  bitsAllocated: number;
  pixelData: Uint8Array;
  frames: SegFrame[];
}

/** Reconstruct a label volume from segmentation frames. */
export function reconstructSegVolume(src: SegSource): ImportedMask {
  const { rows, columns, depth } = src;
  const framePixels = rows * columns;
  const mask = new Uint8Array(columns * rows * depth);
  for (let f = 0; f < src.frames.length; f++) {
    const { segment, z } = src.frames[f]!;
    if (z < 0 || z >= depth) continue;
    const base = z * framePixels;
    for (let p = 0; p < framePixels; p++) {
      let on = 0;
      if (src.bitsAllocated === 1) {
        // DICOM BINARY segmentation packs bits across all frames, LSB-first.
        const bitIndex = f * framePixels + p;
        const byte = src.pixelData[bitIndex >> 3] ?? 0;
        on = (byte >> (bitIndex & 7)) & 1;
      } else {
        on = (src.pixelData[f * framePixels + p] ?? 0) > 127 ? 1 : 0;
      }
      if (on) mask[base + p] = segment;
    }
  }
  return { mask, dims: [columns, rows, depth] };
}

// --- RTSTRUCT contour rasterization ---

export interface Grid {
  origin: [number, number, number];
  spacing: [number, number, number];
  dims: [number, number, number];
}

/** Map a patient-space point (mm) to fractional voxel indices (axial, axis-aligned). */
export function patientToVoxel(p: [number, number, number], grid: Grid): { x: number; y: number; z: number } {
  return {
    x: (p[0] - grid.origin[0]) / grid.spacing[0],
    y: (p[1] - grid.origin[1]) / grid.spacing[1],
    z: Math.round((p[2] - grid.origin[2]) / grid.spacing[2]),
  };
}

export interface VoxelContour {
  z: number;
  label: number;
  points: [number, number][];
}

/** Rasterize per-slice voxel contours into a label volume. */
export function rasterizeContours(contours: VoxelContour[], dims: [number, number, number]): Uint8Array {
  const [nx, ny, nz] = dims;
  const mask = new Uint8Array(nx * ny * nz);
  const framePixels = nx * ny;
  for (const c of contours) {
    if (c.z < 0 || c.z >= nz || c.points.length < 3) continue;
    const poly: Poly = { points: c.points };
    const slice = rasterizePolygon(poly, nx, ny, 1);
    const base = c.z * framePixels;
    for (let p = 0; p < framePixels; p++) {
      if (slice[p]) mask[base + p] = c.label;
    }
  }
  return mask;
}
