/**
 * Pure segmentation scoring core: align a reference mask onto the prediction
 * grid, then compute per-label metrics. Extracted from the benchmark panel so
 * it can run either inline (small volumes) or inside the metrics worker (large
 * volumes, where HD95/ASSD would otherwise jank the UI thread).
 */

import { alignToPrediction, type Grid } from './align';
import { multiLabelMetrics, type MultiLabelResult, type SegMetricsOptions } from './segmentation';

export interface ScoreInputs {
  refMask: Uint8Array;
  refGrid: Grid;
  predMask: Uint8Array;
  predGrid: Grid;
  /** Foreground labels to score. */
  labels: number[];
  options?: SegMetricsOptions;
}

/** Align reference→prediction grid and compute per-label + macro metrics. */
export function scoreSegmentation(input: ScoreInputs): MultiLabelResult {
  const aligned = alignToPrediction(input.refMask, input.refGrid, input.predMask, input.predGrid);
  return multiLabelMetrics(
    aligned.ref,
    input.predMask,
    aligned.dims,
    aligned.spacing,
    input.labels,
    input.options ?? {}
  );
}
