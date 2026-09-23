/**
 * The Examples panel ships only real data: benchmark kits (Zenodo models ×
 * TCIA / MSD) by default, plus image-only public sample scans. No hand-built
 * or synthetic models, nothing fetched from this repo's examples/ folder.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXAMPLE_SELECTION, EXAMPLE_BUNDLES } from '../src/lib/fs/examples';
import { BENCHMARK_KITS } from '../src/lib/catalog/kits';

describe('example bundles', () => {
  it('defaults the picker to the first benchmark kit', () => {
    expect(BENCHMARK_KITS.length).toBeGreaterThan(0);
    expect(DEFAULT_EXAMPLE_SELECTION).toBe(`kit:${BENCHMARK_KITS[0]!.id}`);
  });

  it('lists only image-only sample scans from the public NiiVue images repo', () => {
    expect(EXAMPLE_BUNDLES.length).toBeGreaterThan(0);
    for (const b of EXAMPLE_BUNDLES) {
      expect(b.modelName).toBeNull();
      expect(b.manifestName).toBeNull();
      expect(b.imageName).not.toBeNull();
      for (const f of b.files) {
        expect(f.name).not.toMatch(/\.onnx$|threshold|band|synthetic/i);
        expect(f.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/niivue\/niivue-demo-images\/main\//);
      }
    }
  });
});
