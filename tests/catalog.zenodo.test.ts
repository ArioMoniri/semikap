import { describe, expect, it } from 'vitest';
import { CATALOG_MODELS, mergeModelIndex, parseModelIndex } from '../src/lib/catalog/catalog';
import {
  catalogModelFromResolution,
  conversionCommand,
  parseZenodoRecord,
  parseZenodoRef,
  resolveZenodoFiles,
  VERIFIED_SOURCES,
  zenodoRecordApiUrl,
} from '../src/lib/catalog/zenodo';
import { isAllowedCatalogUrl } from '../src/lib/catalog/fetch';

/** Trimmed `GET https://zenodo.org/api/records/11582728` (legacy `files: []` shape). */
const NNUNET_RECORD = {
  id: 11582728,
  doi: '10.5281/zenodo.11582728',
  metadata: {
    title: 'Pretrained model for 3D semantic image segmentation of the liver and liver lesions from CT scan',
    license: { id: 'cc-by-4.0' },
    creators: [{ name: 'Murugesan, Gowtham Krishnan' }, { name: 'Van Oss, Jeff' }],
  },
  files: [
    {
      key: 'Dataset006_Liver.zip',
      size: 1_216_000_000,
      checksum: 'md5:efbcf11ed43bc86a115f0f07ec7b669f',
      links: { self: 'https://zenodo.org/api/records/11582728/files/Dataset006_Liver.zip/content' },
    },
    { key: 'README.md', size: 2048, checksum: 'md5:00000000000000000000000000000001', links: {} },
  ],
};

/** InvenioRDM shape (`files.entries` map): ONNX + manifest, an orphan ONNX, an unknown .pth and a re-upload of unet.pth. */
const MIXED_RECORD = {
  id: '9990001',
  metadata: {
    title: 'My liver nets',
    rights: [{ id: 'cc-by-4.0' }],
    creators: [{ person_or_org: { name: 'Doe, Jane' } }],
  },
  files: {
    entries: {
      'mynet.onnx': { key: 'mynet.onnx', size: 42_000_000, checksum: 'md5:11111111111111111111111111111111' },
      'mynet.json': { key: 'mynet.json', size: 900, checksum: 'md5:22222222222222222222222222222222' },
      'orphan.onnx': { key: 'orphan.onnx', size: 10, checksum: 'md5:33333333333333333333333333333333' },
      'custom.pth': { key: 'custom.pth', size: 5_000_000, checksum: 'md5:44444444444444444444444444444444' },
      'unet.pth': { key: 'unet.pth', size: 60_000_000, checksum: 'md5:ec7e957f79921627adaa03c24769d1b4' },
      'figure.png': { key: 'figure.png', size: 1, checksum: 'md5:55555555555555555555555555555555' },
    },
  },
};

describe('parseZenodoRef', () => {
  it.each([
    ['11582728', '11582728'],
    ['  21037952 ', '21037952'],
    ['10.5281/zenodo.11582728', '11582728'],
    ['doi:10.5281/zenodo.11582728', '11582728'],
    ['https://doi.org/10.5281/zenodo.21037952', '21037952'],
    ['https://zenodo.org/records/21037952', '21037952'],
    ['https://zenodo.org/record/21037952/files/unet.pth', '21037952'],
    ['https://zenodo.org/api/records/11582728', '11582728'],
    ['https://zenodo.org/doi/10.5281/zenodo.11582728', '11582728'],
  ])('%s → %s', (input, id) => expect(parseZenodoRef(input)).toBe(id));

  it.each(['', 'abc', '10.1000/xyz.1', 'https://evil.io/records/1', 'https://zenodo.org/communities/x'])('rejects "%s"', (input) =>
    expect(parseZenodoRef(input)).toBeNull()
  );

  it('builds an allowlisted https API url', () => {
    expect(zenodoRecordApiUrl('11582728')).toBe('https://zenodo.org/api/records/11582728');
    expect(isAllowedCatalogUrl(zenodoRecordApiUrl('11582728'))).toBe(true);
    expect(() => zenodoRecordApiUrl('1/../x')).toThrow();
  });
});

describe('parseZenodoRecord', () => {
  it('reads the legacy files array with md5 and canonical download URLs', () => {
    const r = parseZenodoRecord(NNUNET_RECORD);
    expect(r).toMatchObject({ id: '11582728', doi: '10.5281/zenodo.11582728', license: 'cc-by-4.0' });
    expect(r.creators).toEqual(['Murugesan, Gowtham Krishnan', 'Van Oss, Jeff']);
    expect(r.files[0]).toEqual({
      key: 'Dataset006_Liver.zip',
      size: 1_216_000_000,
      md5: 'efbcf11ed43bc86a115f0f07ec7b669f',
      url: 'https://zenodo.org/api/records/11582728/files/Dataset006_Liver.zip/content',
    });
    for (const f of r.files) expect(isAllowedCatalogUrl(f.url)).toBe(true);
  });

  it('reads the InvenioRDM files.entries shape and never trusts file links', () => {
    const r = parseZenodoRecord({
      ...MIXED_RECORD,
      files: { entries: { ...MIXED_RECORD.files.entries, x: { key: 'x.onnx', links: { self: 'https://evil.io/x' } } } },
    });
    expect(r.id).toBe('9990001');
    expect(r.doi).toBe('10.5281/zenodo.9990001');
    expect(r.license).toBe('cc-by-4.0');
    expect(r.creators).toEqual(['Doe, Jane']);
    const x = r.files.find((f) => f.key === 'x.onnx')!;
    expect(x.url).toBe('https://zenodo.org/api/records/9990001/files/x.onnx/content');
    expect(x.md5).toBeNull();
  });

  it('rejects non-records', () => {
    expect(() => parseZenodoRecord(null)).toThrow();
    expect(() => parseZenodoRecord({ id: 'abc' })).toThrow(/numeric/);
  });
});

describe('resolveZenodoFiles', () => {
  it('maps the nnU-Net checkpoint to its verified fp32 export by md5 (catalogue record → existing entry)', () => {
    const rec = parseZenodoRecord(NNUNET_RECORD);
    const res = resolveZenodoFiles(rec, null);
    const v = res.find((r) => r.file.key === 'Dataset006_Liver.zip')!;
    expect(v.kind).toBe('verified-conversion');
    if (v.kind !== 'verified-conversion') return;
    expect(v.model.id).toBe('nnunet_liver_lits');
    expect(v.source.sourceMd5).toBe('efbcf11ed43bc86a115f0f07ec7b669f');
    expect(catalogModelFromResolution(rec, v)).toBe(v.model);
    expect(res.find((r) => r.file.key === 'README.md')!.kind).toBe('auxiliary');
  });

  it('classifies ONNX + manifest pairs, unmatched checkpoints, orphans and re-uploads of a verified checkpoint', () => {
    const rec = parseZenodoRecord(MIXED_RECORD);
    const res = resolveZenodoFiles(rec, null);
    const kinds = Object.fromEntries(res.map((r) => [r.file.key, r.kind]));
    expect(kinds).toEqual({
      'mynet.onnx': 'onnx',
      'orphan.onnx': 'needs-conversion',
      'custom.pth': 'needs-conversion',
      'unet.pth': 'verified-conversion',
      'figure.png': 'auxiliary',
    });

    const onnx = res.find((r) => r.kind === 'onnx')!;
    const m = catalogModelFromResolution(rec, onnx)!;
    expect(m).toMatchObject({
      id: 'zenodo9990001_mynet',
      family: 'imported',
      status: 'ok',
      onnxUrl: 'https://zenodo.org/api/records/9990001/files/mynet.onnx/content',
      manifestUrl: 'https://zenodo.org/api/records/9990001/files/mynet.json/content',
      imported: { recordId: '9990001', via: 'onnx' },
    });

    const ver = res.find((r) => r.kind === 'verified-conversion')!;
    const clone = catalogModelFromResolution(rec, ver)!;
    const unet = CATALOG_MODELS.find((x) => x.id === 'lms3d_unet')!;
    expect(clone.id).toBe('zenodo9990001_lms3d_unet');
    expect(clone.onnxUrl).toBe(unet.onnxUrl); // the exact published export of that checkpoint
    expect(clone.zenodoRecord).toBe('9990001');
    expect(clone.imported?.via).toBe('verified-conversion');
    expect(clone.imported?.note).toMatch(/converted from unet\.pth \(md5 match ec7e957f/);

    const pth = res.find((r) => r.file.key === 'custom.pth')!;
    expect(pth.kind === 'needs-conversion' && pth.command).toBe(
      'mkdir -p work/zenodo-9990001 && curl -L --fail -o work/zenodo-9990001/custom.pth ' +
        'https://zenodo.org/api/records/9990001/files/custom.pth/content' +
        " && echo '44444444444444444444444444444444  work/zenodo-9990001/custom.pth' | md5sum -c -" +
        ' && python scripts/zenodo/export_onnx.py lms3d --weights-dir work/zenodo-9990001 --out dist --only custom' +
        ' && python scripts/zenodo/export_onnx.py index --out dist'
    );
    expect(catalogModelFromResolution(rec, pth)).toBeNull();
    // Nothing that needs conversion becomes a loadable (placeholder) model.
    expect(
      res
        .filter((r) => catalogModelFromResolution(rec, r))
        .map((r) => r.kind)
        .sort()
    ).toEqual(['onnx', 'verified-conversion']);
  });

  it('uses the nnU-Net exporter for archives', () => {
    const cmd = conversionCommand('5', {
      key: 'Dataset007_X.zip',
      size: 1,
      md5: null,
      url: 'https://zenodo.org/api/records/5/files/Dataset007_X.zip/content',
    });
    expect(cmd).toContain('unzip -q -o work/zenodo-5/Dataset007_X.zip -d work/zenodo-5/extracted');
    expect(cmd).toContain('export_onnx.py nnunet --model-dir work/zenodo-5/extracted --out dist');
    expect(cmd).not.toContain('md5sum');
  });

  it('prefers the release index; a failed export withdraws the static match', () => {
    const index = parseModelIndex({
      schema: 'tamias.model-index.v1',
      models: [
        { id: 'lms3d_unet', file: 'lms3d_unet.onnx', status: 'failed', error: 'boom', sourceMd5: 'ec7e957f79921627adaa03c24769d1b4' },
        {
          id: 'lms3d_vnet',
          file: 'lms3d_vnet.onnx',
          status: 'ok',
          sourceMd5: '44444444444444444444444444444444',
          sourceFile: 'custom.pth',
          zenodoRecord: '21037952',
          parity: { maxAbsDiff: 0.01, ok: true },
        },
      ],
    });
    const models = mergeModelIndex(CATALOG_MODELS, index);
    const res = resolveZenodoFiles(parseZenodoRecord(MIXED_RECORD), index, models);
    expect(res.find((r) => r.file.key === 'unet.pth')!.kind).toBe('needs-conversion');
    const v = res.find((r) => r.file.key === 'custom.pth')!;
    expect(v.kind).toBe('verified-conversion');
    if (v.kind === 'verified-conversion') {
      expect(v.model.id).toBe('lms3d_vnet');
      expect(v.parity).toEqual({ maxAbsDiff: 0.01, ok: true });
    }
  });

  it('static table covers every catalogue model with the conversion-report md5s', () => {
    expect(VERIFIED_SOURCES.map((v) => v.catalogId).sort()).toEqual(CATALOG_MODELS.map((m) => m.id).sort());
    for (const v of VERIFIED_SOURCES) {
      const m = CATALOG_MODELS.find((x) => x.id === v.catalogId)!;
      expect(v.sourceFile).toBe(m.sourceFile);
      expect(v.zenodoRecord).toBe(m.zenodoRecord);
      expect(v.sourceMd5).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('model index source provenance', () => {
  it('parses and merges sourceMd5 / sourceSha256 / sourceFile / zenodoRecord', () => {
    const idx = parseModelIndex({
      schema: 'tamias.model-index.v1',
      models: [
        {
          id: 'lms3d_unet',
          file: 'lms3d_unet.onnx',
          status: 'ok',
          zenodoRecord: '21037952',
          sourceFile: 'unet.pth',
          sourceMd5: 'EC7E957F79921627ADAA03C24769D1B4',
          sourceSha256: '19d775ffc4d067b1549fcece99c6dec9c50315aa49ea625ca4366db30962c968',
        },
      ],
    });
    expect(idx.models[0]).toMatchObject({ zenodoRecord: '21037952', sourceFile: 'unet.pth', sourceMd5: 'ec7e957f79921627adaa03c24769d1b4' });
    const unet = mergeModelIndex(CATALOG_MODELS, idx).find((m) => m.id === 'lms3d_unet')!;
    expect(unet.sourceMd5).toBe('ec7e957f79921627adaa03c24769d1b4');
    expect(unet.sourceSha256).toMatch(/^19d775/);
  });

  it('rejects malformed source hashes', () => {
    const bad = (extra: Record<string, unknown>) => () =>
      parseModelIndex({ schema: 'tamias.model-index.v1', models: [{ id: 'a', file: 'a.onnx', status: 'ok', ...extra }] });
    expect(bad({ sourceMd5: 'xyz' })).toThrow(/sourceMd5/);
    expect(bad({ sourceSha256: 'abc' })).toThrow(/sourceSha256/);
    expect(bad({ sourceMd5: null })).not.toThrow();
  });
});
