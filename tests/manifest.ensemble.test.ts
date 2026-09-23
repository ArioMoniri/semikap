import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseManifest,
  ensembleDigestInput,
  ensembleRunName,
  ensembleMemberFile,
} from '../src/lib/inference/manifest';
import { CATALOG_ENSEMBLES, CATALOG_MODELS } from '../src/lib/catalog/catalog';

// Member sha256 values + ensemble sha256 as computed by scripts/zenodo/export_onnx.py ensemble_sha256().
const SHAS = [
  '01d448afd928065458cf670b60f5a594d735af0172c8d67f22a81680132681ca',
  'ffadf8d89d37b3b55fe1847b513cf92e3be87e4c168708c7851845df96fb36be',
  '3500d93214caf7f502af5adcd28f8f4fb3620eae3bedbeb327cc5c68a57b3129',
  'dbda5da465810478f5f61b03c8744106cbffe08605d30b5eb695470c087897d8',
  '4001ba71acef633247a0806147b959216c7013b82c0d88630e72e4d6bee6efed',
];
const PY_ENSEMBLE_SHA_TTA = '1b78c5bb999942250c0c3cbcc4215bb09e4546eb9e0ed37094dd913532f188c7';

const ids = ['nnunet_liver_lits', 'nnunet_liver_lits_f1', 'nnunet_liver_lits_f2', 'nnunet_liver_lits_f3', 'nnunet_liver_lits_f4'];

function ens5(overrides: Record<string, unknown> = {}) {
  return {
    name: 'nnU-Net v2 Liver+Lesion 5-fold ensemble',
    version: '1.0.0',
    license: 'CC-BY-4.0',
    modality: 'CT',
    spacing: [0.7676, 0.7676, 1.0],
    orientation: 'RAS',
    normalization: { type: 'zscore_volume' },
    inference: { type: 'sliding_window', patch: [128, 128, 128], overlap: 0.5 },
    output: { type: 'segmentation', labels: { '0': 'background', '8': 'liver', '9': 'tumor' } },
    preferredEP: 'auto',
    ensemble: {
      members: ids.map((id, i) => ({ id, file: `${id}.onnx`, sha256: SHAS[i] })),
      aggregation: 'softmax-mean',
      tta: 'mirror',
      ...overrides,
    },
  };
}

describe('ensemble manifests', () => {
  it('parses the exporter\'s nnunet_liver_lits_ens5.json shape', () => {
    const m = parseManifest(ens5());
    expect(m.ensemble?.members.map((x) => x.id)).toEqual(ids);
    expect(m.ensemble?.aggregation).toBe('softmax-mean');
    expect(m.ensemble?.tta).toBe('mirror');
    expect(m.sha256).toBeUndefined();
    expect(ensembleMemberFile(m.ensemble!.members[1]!)).toBe('nnunet_liver_lits_f1.onnx');
    expect(ensembleMemberFile({ id: 'a', sha256: SHAS[0]! })).toBe('a.onnx');
  });

  it('single-model manifests have no ensemble block', () => {
    const { ensemble: _e, ...single } = ens5();
    expect(parseManifest({ ...single, sha256: SHAS[0] }).ensemble).toBeUndefined();
  });

  it('rejects path-like member ids/files, bad sha256, duplicates and unknown aggregation / tta', () => {
    const bad = (members: unknown, extra: Record<string, unknown> = {}) => () => parseManifest(ens5({ members, ...extra }));
    expect(bad([{ id: '../x', sha256: SHAS[0] }])).toThrow(/plain model id/);
    expect(bad([{ id: 'a', file: '../a.onnx', sha256: SHAS[0] }])).toThrow(/file/);
    expect(bad([{ id: 'a', sha256: 'abc' }])).toThrow(/64 hex/);
    expect(bad([{ id: 'a', sha256: SHAS[0] }, { id: 'a', sha256: SHAS[1] }])).toThrow(/unique/);
    expect(bad([])).toThrow(/non-empty/);
    expect(() => parseManifest(ens5({ aggregation: 'vote' }))).toThrow(/aggregation/);
    expect(() => parseManifest(ens5({ tta: 'flip-x' }))).toThrow(/tta/);
    expect(parseManifest(ens5({ aggregation: 'logit-mean', tta: undefined })).ensemble?.tta).toBeUndefined();
  });

  it('ensemble sha256 = sha256 over the member sha256s (+ tta marker), identical to the Python exporter', () => {
    const spec = parseManifest(ens5()).ensemble!;
    const sha = (tta: boolean) => createHash('sha256').update(ensembleDigestInput(spec, tta), 'utf8').digest('hex');
    expect(ensembleDigestInput(spec, false)).toBe(SHAS.join('\n'));
    expect(sha(true)).toBe(PY_ENSEMBLE_SHA_TTA);
    expect(sha(false)).not.toBe(sha(true));
  });

  it('names TTA runs distinctly', () => {
    const m = parseManifest(ens5());
    expect(ensembleRunName(m, true)).toBe('nnU-Net v2 Liver+Lesion 5-fold ensemble (+mirror TTA)');
    expect(ensembleRunName(m, false)).toBe('nnU-Net v2 Liver+Lesion 5-fold ensemble');
  });
});

describe('catalogue ensemble entry', () => {
  it('describes nnunet_liver_lits_ens5 like fold 0 without joining the single-ONNX list', () => {
    const e = CATALOG_ENSEMBLES.find((m) => m.id === 'nnunet_liver_lits_ens5')!;
    const f0 = CATALOG_MODELS.find((m) => m.id === 'nnunet_liver_lits')!;
    expect(e.family).toBe('nnunet');
    expect(e.trainedOn).toEqual(f0.trainedOn);
    expect(e.labels).toEqual(f0.labels);
    expect(e.sha256).toBeUndefined();
    expect(e.methodsNote).toMatch(/5 cross-validation folds/);
    expect(CATALOG_MODELS.some((m) => m.id === e.id)).toBe(false);
  });
});
