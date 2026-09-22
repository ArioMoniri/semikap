import { describe, expect, it } from 'vitest';
import {
  CATALOG_MODELS,
  CATALOG_DATASETS,
  MODEL_RELEASE_BASE,
  parseModelIndex,
  mergeModelIndex,
  modelsForDataset,
  datasetsForModel,
} from '../src/lib/catalog/catalog';

const LMS3D_ARCHS = [
  'unet',
  'vnet',
  'resunet',
  'attention_unet',
  'unetpp',
  'unetr',
  'swin_unetr',
  'medformer',
  'segformer',
];

describe('static model catalogue', () => {
  it('lists all nine LightningMedSeg3D nets from Zenodo 21037952 plus the nnU-Net liver model from 11582728', () => {
    for (const arch of LMS3D_ARCHS) {
      const m = CATALOG_MODELS.find((x) => x.id === `lms3d_${arch}`);
      expect(m, arch).toBeDefined();
      expect(m!.zenodoRecord).toBe('21037952');
      expect(m!.doi).toBe('10.5281/zenodo.21037952');
      expect(m!.family).toBe('lightningmedseg3d');
    }
    const nn = CATALOG_MODELS.find((x) => x.id === 'nnunet_liver_lits');
    expect(nn).toBeDefined();
    expect(nn!.zenodoRecord).toBe('11582728');
    expect(nn!.family).toBe('nnunet');
    expect(CATALOG_MODELS).toHaveLength(10);
  });

  it('has no TotalSegmentator entries', () => {
    expect(CATALOG_MODELS.some((m) => /totalseg/i.test(m.id + m.name))).toBe(false);
  });

  it('points every model at the zenodo-models-v1 release with a manifest next to the onnx', () => {
    for (const m of CATALOG_MODELS) {
      expect(m.onnxUrl).toBe(`${MODEL_RELEASE_BASE}/${m.id}.onnx`);
      expect(m.manifestUrl).toBe(`${MODEL_RELEASE_BASE}/${m.id}.json`);
      expect(m.zenodoUrl).toBe(`https://zenodo.org/records/${m.zenodoRecord}`);
      expect(m.citation.length).toBeGreaterThan(10);
    }
    expect(MODEL_RELEASE_BASE).toBe(
      'https://github.com/ArioMoniri/semikap/releases/download/zenodo-models-v1'
    );
  });

  it('ids are unique', () => {
    const ids = [...CATALOG_MODELS.map((m) => m.id), ...CATALOG_DATASETS.map((d) => d.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('static dataset catalogue', () => {
  it('includes HCC-TACE-Seg pulled straight from TCIA via the IDC public bucket', () => {
    const d = CATALOG_DATASETS.find((x) => x.id === 'hcc-tace-seg');
    expect(d).toBeDefined();
    expect(d!.doi).toBe('10.7937/TCIA.5FNA-0924');
    expect(d!.license).toBe('CC-BY-4.0');
    expect(d!.access.kind).toBe('idc-s3');
    expect(d!.pageUrl).toBe('https://www.cancerimagingarchive.net/collection/hcc-tace-seg/');
    expect(d!.groundTruth).toContain('liver');
    const acc = d!.access;
    if (acc.kind !== 'idc-s3') throw new Error('expected idc-s3');
    expect(acc.cases).toHaveLength(10);
    for (const c of acc.cases) {
      expect(c.ctSeriesUuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.segSeriesUuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.acquisitionNumber).toBeGreaterThan(0);
    }
    expect(acc.cases.map((c) => c.caseId)).not.toContain('HCC_001');
  });

  it('pairs models with the datasets they were trained on (in-distribution) and HCC-TACE-Seg (external)', () => {
    const unet = CATALOG_MODELS.find((m) => m.id === 'lms3d_unet')!;
    const pairs = datasetsForModel(unet);
    expect(pairs.map((p) => p.id)).toContain('hcc-tace-seg');
    const hcc = CATALOG_DATASETS.find((d) => d.id === 'hcc-tace-seg')!;
    expect(modelsForDataset(hcc)).toHaveLength(10);
  });
});

describe('parseModelIndex', () => {
  const good = {
    schema: 'tamias.model-index.v1',
    release: 'zenodo-models-v1',
    models: [
      {
        id: 'lms3d_unet',
        file: 'lms3d_unet.onnx',
        manifest: 'lms3d_unet.json',
        bytes: 1234,
        sha256: 'a'.repeat(64),
        status: 'ok',
        parity: { maxAbsDiff: 1e-5, ok: true },
        labels: { '0': 'background', '1': 'liver' },
      },
      { id: 'lms3d_unetr', file: 'lms3d_unetr.onnx', status: 'failed', error: 'op not supported' },
    ],
  };

  it('parses a valid index', () => {
    const idx = parseModelIndex(good);
    expect(idx.release).toBe('zenodo-models-v1');
    expect(idx.models).toHaveLength(2);
    expect(idx.models[0]!.sha256).toBe('a'.repeat(64));
    expect(idx.models[1]!.status).toBe('failed');
    expect(idx.models[1]!.error).toBe('op not supported');
  });

  it('rejects wrong schema, non-array models, bad sha256, bad status', () => {
    expect(() => parseModelIndex({ ...good, schema: 'x' })).toThrow();
    expect(() => parseModelIndex({ ...good, models: {} })).toThrow();
    expect(() =>
      parseModelIndex({ ...good, models: [{ ...good.models[0], sha256: 'zz' }] })
    ).toThrow(/sha256/);
    expect(() =>
      parseModelIndex({ ...good, models: [{ ...good.models[0], status: 'maybe' }] })
    ).toThrow(/status/);
  });

  it('merge overlays sha256/bytes/status/labels onto the static entries and keeps unknown ids out', () => {
    const idx = parseModelIndex({
      ...good,
      models: [...good.models, { id: 'evil_model', file: 'x.onnx', status: 'ok' }],
    });
    const merged = mergeModelIndex(CATALOG_MODELS, idx);
    const unet = merged.find((m) => m.id === 'lms3d_unet')!;
    expect(unet.sha256).toBe('a'.repeat(64));
    expect(unet.bytes).toBe(1234);
    expect(unet.status).toBe('ok');
    expect(unet.labels).toEqual({ 0: 'background', 1: 'liver' });
    expect(merged.find((m) => m.id === 'lms3d_unetr')!.status).toBe('failed');
    expect(merged.find((m) => m.id === 'evil_model')).toBeUndefined();
    // Entries not in the index are "unpublished", not silently "ok".
    expect(merged.find((m) => m.id === 'lms3d_vnet')!.status).toBe('unpublished');
    expect(merged).toHaveLength(CATALOG_MODELS.length);
  });

  it('prefers a Hugging Face mirror (CORS-friendly) and keeps the GitHub release as fallback', () => {
    const base = 'https://huggingface.co/Aralario/tamias-zenodo-liver-models/resolve/main';
    // A mirror is only used for entries whose sha256 is pinned by the index.
    const noSha = mergeModelIndex(
      CATALOG_MODELS,
      parseModelIndex({ ...good, mirrors: [base], models: [{ id: 'lms3d_unet', file: 'lms3d_unet.onnx', status: 'ok' }] })
    ).find((m) => m.id === 'lms3d_unet')!;
    expect(noSha.onnxUrl).toBe(`${MODEL_RELEASE_BASE}/lms3d_unet.onnx`);
    const idx = parseModelIndex({ ...good, mirrors: [base] });
    const unet = mergeModelIndex(CATALOG_MODELS, idx).find((m) => m.id === 'lms3d_unet')!;
    expect(unet.onnxUrl).toBe(`${base}/lms3d_unet.onnx`);
    expect(unet.manifestUrl).toBe(`${base}/lms3d_unet.json`);
    expect(unet.fallbackOnnxUrl).toBe(`${MODEL_RELEASE_BASE}/lms3d_unet.onnx`);
  });

  it('ignores mirrors that are not huggingface.co tamias model repos', () => {
    for (const bad of [
      'https://evil.example/tamias-zenodo-liver-models/resolve/main',
      'http://huggingface.co/a/tamias-zenodo-liver-models/resolve/main',
      'https://huggingface.co/a/other-repo/resolve/main',
      'https://huggingface.co.evil.io/a/tamias-zenodo-liver-models/resolve/main',
      'https://huggingface.co/attacker/tamias-zenodo-liver-models/resolve/main',
    ]) {
      const idx = parseModelIndex({ ...good, mirrors: [bad] });
      expect(idx.mirrors).toEqual([]);
    }
  });
});
