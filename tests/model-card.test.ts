import { describe, expect, it } from 'vitest';
import type { ModelManifest } from '../src/types';
import type { OnnxValidation } from '../src/lib/registry/onnx-validate';
import {
  buildModelCard,
  modelCardToMarkdown,
  type BuildModelCardInput,
} from '../src/lib/registry/model-card';

function manifest(overrides: Partial<ModelManifest> = {}): ModelManifest {
  return {
    name: 'Liver Seg',
    version: '1.2.0',
    license: 'Apache-2.0',
    modality: 'CT',
    spacing: [1.5, 1.5, 1.5],
    orientation: 'RAS',
    normalization: { kind: 'zscore' },
    inference: { kind: 'whole' },
    output: { type: 'segmentation', labels: { 1: 'liver' } },
    ...overrides,
  } as ModelManifest;
}

function validation(overrides: Partial<OnnxValidation> = {}): OnnxValidation {
  return {
    ok: true,
    irVersion: 8,
    opsets: [{ domain: '', version: 18 }],
    inputs: ['input'],
    outputs: ['output'],
    nodeCount: 42,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

describe('buildModelCard', () => {
  it('builds a card from manifest + validation (happy path)', () => {
    const input: BuildModelCardInput = {
      manifest: manifest(),
      validation: validation(),
      intendedUse: 'Research liver segmentation on portal-venous CT.',
      limitations: 'Not for clinical use.',
      metricsSummary: 'Mean Dice 0.94 over 30 cases.',
      generatedAt: '2026-07-12T00:00:00.000Z',
    };
    const card = buildModelCard(input);
    expect(card).toEqual({
      schema: 'tamias.modelcard.v1',
      name: 'Liver Seg',
      version: '1.2.0',
      license: 'Apache-2.0',
      modality: 'CT',
      intendedUse: 'Research liver segmentation on portal-venous CT.',
      limitations: 'Not for clinical use.',
      opsets: [{ domain: '', version: 18 }],
      inputs: ['input'],
      outputs: ['output'],
      nodeCount: 42,
      metricsSummary: 'Mean Dice 0.94 over 30 cases.',
      generatedAt: '2026-07-12T00:00:00.000Z',
    });
  });

  it('omits optional fields when absent or blank', () => {
    const card = buildModelCard({
      manifest: manifest({ modality: 'MR' }),
      validation: validation({ nodeCount: undefined }),
      intendedUse: '   ',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(card).not.toHaveProperty('intendedUse');
    expect(card).not.toHaveProperty('limitations');
    expect(card).not.toHaveProperty('metricsSummary');
    expect(card).not.toHaveProperty('nodeCount');
    expect(card.modality).toBe('MR');
  });

  it('copies array fields defensively (no shared references)', () => {
    const v = validation();
    const card = buildModelCard({
      manifest: manifest(),
      validation: v,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(card.inputs).not.toBe(v.inputs);
    expect(card.outputs).not.toBe(v.outputs);
    expect(card.opsets[0]).not.toBe(v.opsets[0]);
    expect(card.opsets[0]).toEqual({ domain: '', version: 18 });
  });
});

describe('modelCardToMarkdown', () => {
  it('includes name, version, and opset', () => {
    const card = buildModelCard({
      manifest: manifest(),
      validation: validation({ opsets: [{ domain: '', version: 18 }] }),
      generatedAt: '2026-07-12T00:00:00.000Z',
    });
    const md = modelCardToMarkdown(card);
    expect(md).toContain('# Model Card: Liver Seg');
    expect(md).toContain('**Version:** 1.2.0');
    // empty default domain renders as ai.onnx
    expect(md).toContain('**Opsets:** ai.onnx@18');
    expect(md).toContain('**Nodes:** 42');
  });

  it('renders named opset domains verbatim and joins multiple opsets', () => {
    const card = buildModelCard({
      manifest: manifest(),
      validation: validation({
        opsets: [
          { domain: '', version: 18 },
          { domain: 'com.microsoft', version: 1 },
        ],
      }),
      generatedAt: '2026-07-12T00:00:00.000Z',
    });
    const md = modelCardToMarkdown(card);
    expect(md).toContain('**Opsets:** ai.onnx@18, com.microsoft@1');
  });

  it('omits optional sections when the fields are absent', () => {
    const card = buildModelCard({
      manifest: manifest(),
      validation: validation({ nodeCount: undefined }),
      generatedAt: '2026-07-12T00:00:00.000Z',
    });
    const md = modelCardToMarkdown(card);
    expect(md).not.toContain('## Intended Use');
    expect(md).not.toContain('## Limitations');
    expect(md).not.toContain('## Metrics');
    expect(md).not.toContain('**Nodes:**');
  });

  it('includes optional sections when the fields are present', () => {
    const card = buildModelCard({
      manifest: manifest(),
      validation: validation(),
      intendedUse: 'Research only.',
      limitations: 'CT abdomen only.',
      metricsSummary: 'Dice 0.94.',
      generatedAt: '2026-07-12T00:00:00.000Z',
    });
    const md = modelCardToMarkdown(card);
    expect(md).toContain('## Intended Use\n\nResearch only.');
    expect(md).toContain('## Limitations\n\nCT abdomen only.');
    expect(md).toContain('## Metrics\n\nDice 0.94.');
  });
});
