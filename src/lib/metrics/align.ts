/**
 * Grid alignment for benchmarking: a reference label mask and a model
 * prediction rarely live on the identical voxel grid (different resample
 * targets, cropping). Before computing overlap/surface metrics we resample the
 * reference onto the prediction's grid with nearest-neighbour interpolation
 * (label-preserving), reusing the inference postprocessor.
 */

import { resampleNearest } from '../inference/postprocess';
import type { Bytes } from '../../types';

export interface Grid {
  dims: readonly [number, number, number];
  spacing: readonly [number, number, number];
}

export interface AlignedMasks {
  ref: Uint8Array;
  pred: Uint8Array;
  dims: readonly [number, number, number];
  spacing: readonly [number, number, number];
}

/**
 * Align `ref` onto `pred`'s grid. If the grids already match, `ref` is returned
 * unchanged. Throws if either buffer length is inconsistent with its dims.
 */
export function alignToPrediction(
  ref: Uint8Array,
  refGrid: Grid,
  pred: Uint8Array,
  predGrid: Grid
): AlignedMasks {
  assertLen(ref, refGrid.dims, 'reference');
  assertLen(pred, predGrid.dims, 'prediction');

  const sameGrid =
    refGrid.dims[0] === predGrid.dims[0] &&
    refGrid.dims[1] === predGrid.dims[1] &&
    refGrid.dims[2] === predGrid.dims[2];

  const alignedRef: Uint8Array = sameGrid
    ? ref
    : (resampleNearest(ref, refGrid.dims, predGrid.dims) as Bytes);

  return {
    ref: alignedRef,
    pred,
    dims: predGrid.dims,
    spacing: predGrid.spacing,
  };
}

function assertLen(
  mask: Uint8Array,
  dims: readonly [number, number, number],
  which: string
): void {
  const expected = dims[0] * dims[1] * dims[2];
  if (mask.length !== expected) {
    throw new Error(
      `alignToPrediction: ${which} mask length ${mask.length} != dims product ${expected}.`
    );
  }
}
