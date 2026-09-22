/**
 * Label-group scoring: score unions of labels as one structure.
 *
 * Liver models label parenchyma (1) and tumour (2) separately, and so do
 * ground truths — but whole-organ agreement (liver ∪ tumour) is what a
 * liver-segmentation benchmark reports, and calling a tumour voxel "liver"
 * is not an organ-segmentation error. Groups make that explicit.
 */

import { segmentationMetrics, type SegMetrics, type SegMetricsOptions } from './segmentation';

export interface LabelGroup {
  /** Label id reported in SegMetrics.label for this group. */
  id: number;
  name: string;
  members: number[];
}

export const LIVER_TUMOUR_GROUPS: readonly LabelGroup[] = [
  { id: 1, name: 'liver (whole organ: liver ∪ tumour)', members: [1, 2] },
  { id: 2, name: 'tumour', members: [2] },
];

export function groupMask(mask: Uint8Array, members: readonly number[]): Uint8Array {
  const set = new Uint8Array(256);
  for (const m of members) set[m] = 1;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = set[mask[i]!]!;
  return out;
}

export function scoreLabelGroups(
  ref: Uint8Array,
  pred: Uint8Array,
  dims: [number, number, number],
  spacing: [number, number, number],
  groups: readonly LabelGroup[],
  opts: SegMetricsOptions = {}
): SegMetrics[] {
  return groups.map((g) => ({
    ...segmentationMetrics(groupMask(ref, g.members), groupMask(pred, g.members), dims, spacing, 1, opts),
    label: g.id,
  }));
}
