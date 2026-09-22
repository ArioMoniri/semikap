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

/** A group whose members differ between the reference and the prediction label spaces. */
export interface MappedLabelGroup {
  id: number;
  name: string;
  refMembers: number[];
  predMembers: number[];
}

const TUMOUR_RE = /^(tumou?r|lesion|liver[ _-]?tumou?r|hcc|mass|cancer)s?$/i;
const LIVER_RE = /^liver$/i;

/**
 * Canonical liver/tumour groups for a model from its manifest label names.
 * Reference convention (catalogue GT): 1 = liver parenchyma, 2 = tumour.
 */
export function groupsForModelLabels(labels: Record<number, string>): MappedLabelGroup[] {
  const entries = Object.entries(labels).map(([k, v]) => [Number(k), v.trim()] as const);
  const liver = entries.filter(([, n]) => LIVER_RE.test(n)).map(([k]) => k);
  const tumour = entries.filter(([, n]) => TUMOUR_RE.test(n)).map(([k]) => k);
  if (!liver.length) throw new Error('Model has no "liver" output label; cannot score against liver ground truth.');
  const groups: MappedLabelGroup[] = [
    { id: 1, name: LIVER_TUMOUR_GROUPS[0]!.name, refMembers: [1, 2], predMembers: [...liver, ...tumour].sort((a, b) => a - b) },
  ];
  if (tumour.length) groups.push({ id: 2, name: 'tumour', refMembers: [2], predMembers: tumour });
  return groups;
}

export function scoreLabelGroupsMapped(
  ref: Uint8Array,
  pred: Uint8Array,
  dims: [number, number, number],
  spacing: [number, number, number],
  groups: readonly MappedLabelGroup[],
  opts: SegMetricsOptions = {}
): SegMetrics[] {
  return groups.map((g) => ({
    ...segmentationMetrics(groupMask(ref, g.refMembers), groupMask(pred, g.predMembers), dims, spacing, 1, opts),
    label: g.id,
  }));
}

/** Binary ref/pred masks per canonical group (for the in-app scoring worker). */
export function canonicalGroupMasks(
  ref: Uint8Array,
  pred: Uint8Array,
  predLabels: Record<number, string>
): Array<{ id: number; name: string; ref: Uint8Array; pred: Uint8Array }> {
  return groupsForModelLabels(predLabels).map((g) => ({
    id: g.id,
    name: g.name,
    ref: groupMask(ref, g.refMembers),
    pred: groupMask(pred, g.predMembers),
  }));
}
