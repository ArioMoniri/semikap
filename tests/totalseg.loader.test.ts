/**
 * Unit tests for the v0.7.4 TotalSegmentator loader + manifest schema.
 *
 * Goals:
 *   1. The manifest parser rejects malformed inputs with a clear error.
 *   2. The BYO manifest builder produces a schema-conformant object so
 *      the panel can hand it straight to loadTotalSegModel without an
 *      additional validation pass.
 *   3. The preset list ships exactly the BYO entry until a real ONNX
 *      export lands; this test pins the current shape so an accidental
 *      preset addition surfaces in code review.
 *
 * No network IO — loadTotalSegModel itself isn't exercised here
 * because hitting HuggingFace from CI would be flaky and slow. The
 * download path is covered by the panel's manual-test plan in
 * docs/TOTALSEGMENTATOR.md.
 */

import { describe, expect, it } from 'vitest';
import {
  PRESET_TOTALSEG_MODELS,
  buildCustomTotalSegManifest,
} from '../src/lib/totalseg/loader';
import {
  parseTotalSegManifest,
  type TotalSegManifest,
} from '../src/lib/totalseg/types';

describe('parseTotalSegManifest', () => {
  it('accepts a minimal valid manifest and returns a fresh object', () => {
    const input: TotalSegManifest = {
      kind: 'totalseg',
      name: 'Test',
      family: 'totalseg',
      license: 'MIT',
      model: { url: 'https://example.com/model.onnx' },
      spacing: [1.5, 1.5, 1.5],
      patch: [128, 128, 128],
      output: { type: 'multilabel', classes: 117 },
      labels: [{ id: 0, name: 'background' }],
    };
    const parsed = parseTotalSegManifest(input);
    expect(parsed).toEqual(input);
    // Returned object is a copy, not the same reference.
    expect(parsed).not.toBe(input);
  });

  it('rejects when kind is wrong', () => {
    expect(() =>
      parseTotalSegManifest({
        kind: 'sam',
        name: 'X',
        family: 'totalseg',
        license: '',
        model: {},
        spacing: [1, 1, 1],
        patch: [1, 1, 1],
        output: { type: 'multilabel', classes: 1 },
        labels: [],
      })
    ).toThrow(/kind/);
  });

  it('rejects when spacing is not a 3-tuple', () => {
    expect(() =>
      parseTotalSegManifest({
        kind: 'totalseg',
        name: 'X',
        family: 'totalseg',
        license: '',
        model: {},
        spacing: [1.5, 1.5],
        patch: [128, 128, 128],
        output: { type: 'multilabel', classes: 1 },
        labels: [],
      })
    ).toThrow(/spacing/);
  });

  it('rejects when labels is not an array', () => {
    expect(() =>
      parseTotalSegManifest({
        kind: 'totalseg',
        name: 'X',
        family: 'totalseg',
        license: '',
        model: { url: '' },
        spacing: [1, 1, 1],
        patch: [1, 1, 1],
        output: { type: 'multilabel', classes: 1 },
        labels: { not: 'an array' },
      })
    ).toThrow(/labels/);
  });

  it('rejects non-objects', () => {
    expect(() => parseTotalSegManifest(null)).toThrow();
    expect(() => parseTotalSegManifest('string')).toThrow();
    expect(() => parseTotalSegManifest(42)).toThrow();
  });
});

describe('buildCustomTotalSegManifest', () => {
  it('produces a schema-conformant manifest with sensible defaults', () => {
    const m = buildCustomTotalSegManifest({
      name: 'My Seg',
      modelUrl: 'https://example.com/totalseg.onnx',
    });
    expect(() => parseTotalSegManifest(m)).not.toThrow();
    expect(m.family).toBe('custom');
    expect(m.spacing).toEqual([1.5, 1.5, 1.5]);
    expect(m.patch).toEqual([128, 128, 128]);
    expect(m.output.type).toBe('multilabel');
    expect(m.output.classes).toBe(117);
    expect(m.model.url).toBe('https://example.com/totalseg.onnx');
    expect(m.model.sha256).toBeUndefined();
  });

  it('threads SHA-256 through when provided', () => {
    const m = buildCustomTotalSegManifest({
      name: 'X',
      modelUrl: 'https://example.com/x.onnx',
      sha256: 'a'.repeat(64),
    });
    expect(m.model.sha256).toBe('a'.repeat(64));
  });

  it('honours overrides for spacing / patch / classes', () => {
    const m = buildCustomTotalSegManifest({
      name: 'X',
      modelUrl: 'https://example.com/x.onnx',
      spacing: [2, 2, 2],
      patch: [96, 96, 96],
      classes: 5,
    });
    expect(m.spacing).toEqual([2, 2, 2]);
    expect(m.patch).toEqual([96, 96, 96]);
    expect(m.output.classes).toBe(5);
  });
});

describe('PRESET_TOTALSEG_MODELS', () => {
  it('ships the Aralario total_fast preset + the BYO entry (v0.10.12+)', () => {
    // v0.10.12 — added the Aralario/totalsegmentator-onnx-total-fast
    // preset alongside the existing BYO entry. Order matters: preset
    // first (so it's the default in the dropdown), BYO last.
    expect(PRESET_TOTALSEG_MODELS).toHaveLength(2);
    const preset = PRESET_TOTALSEG_MODELS[0]!;
    expect(preset.id).toBe('aralario-total-fast');
    expect(preset.manifest.model.url).toMatch(
      /huggingface\.co\/Aralario\/totalsegmentator-onnx-total-fast\/resolve\/main\/fold_0\.onnx$/
    );
    expect(preset.manifest.output.classes).toBe(118);
    expect(preset.approxBytes).toBeGreaterThan(50_000_000);
    const byo = PRESET_TOTALSEG_MODELS[1]!;
    expect(byo.id).toBe('byo-url');
    expect(byo.manifest.model.url).toBeNull();
    expect(byo.manifest.kind).toBe('totalseg');
    // Background label always present so the runtime can render an
    // empty mask without crashing.
    expect(byo.manifest.labels[0]?.id).toBe(0);
    expect(byo.manifest.labels[0]?.name).toBe('background');
  });

  it('every preset round-trips through the manifest parser', () => {
    for (const p of PRESET_TOTALSEG_MODELS) {
      expect(() => parseTotalSegManifest(p.manifest)).not.toThrow();
    }
  });
});
