import { describe, expect, it, vi } from 'vitest';
import { loadCatalogModel, fetchIdcSeriesFiles } from '../src/lib/catalog/load';
import { CATALOG_MODELS } from '../src/lib/catalog/catalog';
import { sha256Hex } from '../src/lib/fs/opfs';

const manifest = {
  name: 'LMS3D U-Net',
  version: '1.0.0',
  license: 'CC-BY-4.0',
  modality: 'CT',
  spacing: [1.5, 1.5, 2.0],
  orientation: 'RAS',
  normalization: { type: 'none' },
  inference: { type: 'sliding_window', patch: [96, 96, 96], overlap: 0.5 },
  output: { type: 'segmentation', labels: { 0: 'background', 1: 'liver' } },
};

describe('loadCatalogModel', () => {
  const onnx = new TextEncoder().encode('fake-onnx');

  it('downloads manifest + onnx, verifies sha, caches, and returns a ModelRecord', async () => {
    const sha = await sha256Hex(onnx);
    const model = { ...CATALOG_MODELS[0]!, sha256: sha, status: 'ok' as const };
    const fetchAsset = vi.fn(async (url: string) =>
      url.endsWith('.json') ? new TextEncoder().encode(JSON.stringify({ ...manifest, sha256: sha })) : onnx
    );
    const cache = vi.fn(async () => undefined);
    const rec = await loadCatalogModel(model, { fetchAsset, cache, findCached: async () => null });
    expect(rec.hash).toBe(sha);
    expect(rec.manifest.name).toBe('LMS3D U-Net');
    expect(rec.source.hint).toBe(`catalog:${model.id}`);
    expect(fetchAsset).toHaveBeenCalledWith(model.onnxUrl, { expectedSha256: sha });
    expect(cache).toHaveBeenCalledOnce();
  });

  it('uses the OPFS cache when the hash is already present (no onnx download)', async () => {
    const sha = await sha256Hex(onnx);
    const model = { ...CATALOG_MODELS[0]!, sha256: sha, status: 'ok' as const };
    const fetchAsset = vi.fn(async () => new TextEncoder().encode(JSON.stringify(manifest)));
    const rec = await loadCatalogModel(model, {
      fetchAsset,
      cache: vi.fn(),
      findCached: async (h) => (h === sha ? onnx : null),
    });
    expect(rec.bytes).toBe(onnx);
    expect(fetchAsset).toHaveBeenCalledTimes(1); // manifest only
  });

  it('falls back to the GitHub release when the mirror download fails', async () => {
    const sha = await sha256Hex(onnx);
    const model = {
      ...CATALOG_MODELS[0]!,
      sha256: sha,
      status: 'ok' as const,
      onnxUrl: 'https://huggingface.co/a/tamias-zenodo-liver-models/resolve/main/lms3d_unet.onnx',
      manifestUrl: 'https://huggingface.co/a/tamias-zenodo-liver-models/resolve/main/lms3d_unet.json',
      fallbackOnnxUrl: CATALOG_MODELS[0]!.onnxUrl,
      fallbackManifestUrl: CATALOG_MODELS[0]!.manifestUrl,
    };
    const fetchAsset = vi.fn(async (url: string) => {
      if (url.includes('huggingface')) throw new Error('mirror down');
      return url.endsWith('.json') ? new TextEncoder().encode(JSON.stringify(manifest)) : onnx;
    });
    const rec = await loadCatalogModel(model, { fetchAsset, cache: vi.fn(), findCached: async () => null });
    expect(rec.hash).toBe(sha);
    expect(fetchAsset).toHaveBeenCalledWith(CATALOG_MODELS[0]!.onnxUrl, { expectedSha256: sha });
  });

  it('refuses failed/unpublished models with a clear message', async () => {
    const failed = { ...CATALOG_MODELS[0]!, status: 'failed' as const, error: 'op X' };
    await expect(
      loadCatalogModel(failed, { fetchAsset: vi.fn(), cache: vi.fn(), findCached: async () => null })
    ).rejects.toThrow(/op X/);
  });

  it('rejects a manifest whose sha256 disagrees with the release index', async () => {
    const model = { ...CATALOG_MODELS[0]!, sha256: 'a'.repeat(64), status: 'ok' as const };
    const fetchAsset = vi.fn(async () =>
      new TextEncoder().encode(JSON.stringify({ ...manifest, sha256: 'b'.repeat(64) }))
    );
    await expect(
      loadCatalogModel(model, { fetchAsset, cache: vi.fn(), findCached: async () => null })
    ).rejects.toThrow(/sha256/i);
  });
});

describe('fetchIdcSeriesFiles', () => {
  it('lists then downloads every object with bounded concurrency, preserving order', async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://idc-open-data.s3.amazonaws.com/s/${i}.dcm`);
    let inFlight = 0;
    let peak = 0;
    const fetchAsset = vi.fn(async (u: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return new TextEncoder().encode(u);
    });
    const progress: number[] = [];
    const files = await fetchIdcSeriesFiles('s', {
      list: async () => urls,
      fetchAsset,
      concurrency: 4,
      onProgress: (d) => progress.push(d),
    });
    expect(files).toHaveLength(20);
    expect(files[7]!.name).toBe('7.dcm');
    expect(new TextDecoder().decode(files[7]!.bytes)).toBe(urls[7]);
    expect(peak).toBeLessThanOrEqual(4);
    expect(progress.at(-1)).toBe(20);
  });

  it('throws when the series is empty', async () => {
    await expect(
      fetchIdcSeriesFiles('s', { list: async () => [], fetchAsset: vi.fn() })
    ).rejects.toThrow(/no DICOM/);
  });
});
