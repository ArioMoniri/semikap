/**
 * Model-card generation (Phase 4).
 *
 * Combines a {@link ModelManifest} (the authored contract), an
 * {@link OnnxValidation} (structural facts read from the .onnx file), and an
 * optional human-authored metrics summary into a serializable `ModelCard`, plus
 * a renderer that turns that card into human-readable Markdown.
 *
 * Pure functions: no DOM, no network, no clock reads — the caller supplies
 * `generatedAt` so output is deterministic and testable.
 */

import type { ModelManifest } from '../../types';
import type { OnnxValidation } from './onnx-validate';

/** Serializable model card. `schema` pins the shape for forward compatibility. */
export interface ModelCard {
  schema: 'tamias.modelcard.v1';
  name: string;
  version: string;
  license: string;
  modality: string;
  intendedUse?: string;
  limitations?: string;
  opsets: { domain: string; version: number }[];
  inputs: string[];
  outputs: string[];
  nodeCount?: number;
  metricsSummary?: string;
  generatedAt: string;
}

/** Inputs required to build a {@link ModelCard}. */
export interface BuildModelCardInput {
  manifest: ModelManifest;
  validation: OnnxValidation;
  intendedUse?: string;
  limitations?: string;
  metricsSummary?: string;
  generatedAt: string;
}

/** True for a string that is present and not blank after trimming. */
function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build a model card from a manifest, ONNX validation, and optional metadata.
 * Optional string fields (intendedUse/limitations/metricsSummary) and
 * `nodeCount` are omitted from the result when absent or blank.
 */
export function buildModelCard(input: BuildModelCardInput): ModelCard {
  const { manifest, validation } = input;
  const card: ModelCard = {
    schema: 'tamias.modelcard.v1',
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    modality: manifest.modality,
    opsets: validation.opsets.map((o) => ({ domain: o.domain, version: o.version })),
    inputs: [...validation.inputs],
    outputs: [...validation.outputs],
    generatedAt: input.generatedAt,
  };
  if (present(input.intendedUse)) card.intendedUse = input.intendedUse;
  if (present(input.limitations)) card.limitations = input.limitations;
  if (present(input.metricsSummary)) card.metricsSummary = input.metricsSummary;
  if (typeof validation.nodeCount === 'number') card.nodeCount = validation.nodeCount;
  return card;
}

/** Format one opset import as `domain@version`, using `ai.onnx` for the empty default domain. */
function formatOpset(opset: { domain: string; version: number }): string {
  const domain = opset.domain.length > 0 ? opset.domain : 'ai.onnx';
  return `${domain}@${opset.version}`;
}

/**
 * Render a {@link ModelCard} as human-readable Markdown; sections for optional
 * fields are omitted when the corresponding field is absent.
 */
export function modelCardToMarkdown(card: ModelCard): string {
  const lines: string[] = [];
  lines.push(`# Model Card: ${card.name}`);
  lines.push('');
  lines.push(`- **Version:** ${card.version}`);
  lines.push(`- **License:** ${card.license}`);
  lines.push(`- **Modality:** ${card.modality}`);
  lines.push(`- **Generated:** ${card.generatedAt}`);
  lines.push('');

  if (present(card.intendedUse)) {
    lines.push('## Intended Use');
    lines.push('');
    lines.push(card.intendedUse);
    lines.push('');
  }

  if (present(card.limitations)) {
    lines.push('## Limitations');
    lines.push('');
    lines.push(card.limitations);
    lines.push('');
  }

  lines.push('## Model Structure');
  lines.push('');
  const opsetText = card.opsets.length > 0 ? card.opsets.map(formatOpset).join(', ') : '(none)';
  lines.push(`- **Opsets:** ${opsetText}`);
  lines.push(`- **Inputs:** ${card.inputs.length > 0 ? card.inputs.join(', ') : '(none)'}`);
  lines.push(`- **Outputs:** ${card.outputs.length > 0 ? card.outputs.join(', ') : '(none)'}`);
  if (typeof card.nodeCount === 'number') {
    lines.push(`- **Nodes:** ${card.nodeCount}`);
  }
  lines.push('');

  if (present(card.metricsSummary)) {
    lines.push('## Metrics');
    lines.push('');
    lines.push(card.metricsSummary);
    lines.push('');
  }

  return lines.join('\n');
}
