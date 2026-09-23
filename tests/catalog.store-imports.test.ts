import { describe, expect, it } from 'vitest';
import { useCatalogStore } from '../src/lib/state/catalogStore';
import { CATALOG_MODELS, mergeModelIndex } from '../src/lib/catalog/catalog';
import { catalogModelFromResolution, parseZenodoRecord, resolveZenodoFiles } from '../src/lib/catalog/zenodo';
import { idcImportCase } from '../src/lib/catalog/imported-cases';

const rec = parseZenodoRecord({
  id: 4242,
  metadata: { title: 'x', creators: [] },
  files: [
    { key: 'net.onnx', size: 1, checksum: 'md5:11111111111111111111111111111111' },
    { key: 'net.json', size: 1, checksum: 'md5:22222222222222222222222222222222' },
  ],
});

describe('catalogue store imports', () => {
  it('imported models join the list, survive a release-index refresh and can be removed', () => {
    const m = catalogModelFromResolution(rec, resolveZenodoFiles(rec, null)[0]!)!;
    const s = useCatalogStore.getState();
    s.addImportedModels([m, m]);
    expect(useCatalogStore.getState().models.filter((x) => x.id === m.id)).toHaveLength(1);
    // Built-in ids are never duplicated.
    s.addImportedModels([CATALOG_MODELS[0]!]);
    expect(useCatalogStore.getState().models).toHaveLength(CATALOG_MODELS.length + 1);

    useCatalogStore.getState().setModels(mergeModelIndex(CATALOG_MODELS, { release: 'r', models: [], mirrors: [] }));
    expect(useCatalogStore.getState().models.map((x) => x.id)).toContain(m.id);

    useCatalogStore.getState().setSelectedModels([m.id, 'lms3d_unet']);
    useCatalogStore.getState().removeImportedModel(m.id);
    expect(useCatalogStore.getState().models.map((x) => x.id)).not.toContain(m.id);
    expect(useCatalogStore.getState().selectedModels).toEqual(['lms3d_unet']);
    useCatalogStore.getState().removeImportedModel('lms3d_unet'); // built-ins stay
    expect(useCatalogStore.getState().models).toHaveLength(CATALOG_MODELS.length);
  });

  it('imported cases get unique ids', () => {
    const c = idcImportCase('463d9b31-b4b6-4b01-897d-209ef1770324', 'fdd409a9-54d8-481c-bba3-28c3833007bc', 'X');
    useCatalogStore.getState().addImportedCases([c, c]);
    expect(useCatalogStore.getState().importedCases.map((x) => x.caseId)).toEqual(['X', 'X#2']);
    useCatalogStore.getState().removeImportedCase('X');
    expect(useCatalogStore.getState().importedCases.map((x) => x.caseId)).toEqual(['X#2']);
  });
});
