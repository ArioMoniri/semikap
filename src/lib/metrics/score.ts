/**
 * Pure segmentation scoring core: align a reference mask onto the prediction
 * grid, then compute per-label metrics. Extracted from the benchmark panel so
 * it can run either inline (small volumes) or inside the metrics worker (large
 * volumes, where HD95/ASSD would otherwise jank the UI thread).
 */

import { alignToPrediction, type Grid } from './align';
import { multiLabelMetrics, type MultiLabelResult, type SegMetricsOptions } from './segmentation';
import { groupMask, groupsForModelLabels } from './label-groups';
import { lesionDetection, type LesionDetection } from './lesions';

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

/**
 * Lesion-wise detection of a liver/tumour prediction against the catalogue
 * reference (1 liver, 2 tumour), reference aligned onto the prediction grid.
 * Undefined for models without a tumour class.
 */
export function scoreLesions(input: {
  refMask: Uint8Array;
  refGrid: Grid;
  predMask: Uint8Array;
  predGrid: Grid;
  predLabels: Record<number, string>;
  minVolumeMl?: number;
}): LesionDetection | undefined {
  const t = groupsForModelLabels(input.predLabels).find((g) => g.id === 2);
  if (!t) return undefined;
  const pred = groupMask(input.predMask, t.predMembers);
  const a = alignToPrediction(groupMask(input.refMask, t.refMembers), input.refGrid, pred, input.predGrid);
  return lesionDetection(a.ref, pred, a.dims, a.spacing, input.minVolumeMl);
}
