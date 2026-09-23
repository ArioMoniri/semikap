/**
 * Model & Dataset Catalogue.
 *
 * A curated, choosable + loadable list of published liver-CT segmentation
 * models and the public datasets to benchmark them on, so TAMIAS can be used
 * as a model benchmarking / comparison platform without the user hunting
 * for weights or scans.
 *
 * Models — the original checkpoints live on Zenodo as PyTorch weights, which
 * a browser cannot execute. A GitHub Actions job
 * (`.github/workflows/zenodo-models.yml`) downloads them from Zenodo,
 * exports each one to ONNX with a parity check, and publishes the ONNX +
 * TAMIAS manifest as assets of the `zenodo-models-v1` release. The catalogue
 * points at those assets and keeps the Zenodo DOI as provenance. The
 * release also carries `zenodo-models-index.json` (sha256, size, labels,
 * parity) which is merged over the static entries below at runtime.
 *
 * Datasets — HCC-TACE-Seg is pulled straight from TCIA's public mirror on
 * the NCI Imaging Data Commons bucket (CORS-enabled, no login), CT + the
 * expert DICOM-SEG ground truth.
 */

export const MODEL_RELEASE_TAG = 'zenodo-models-v1';
export const MODEL_RELEASE_BASE = `https://github.com/ArioMoniri/semikap/releases/download/${MODEL_RELEASE_TAG}`;
export const MODEL_INDEX_URL = `${MODEL_RELEASE_BASE}/zenodo-models-index.json`;
/**
 * CORS-friendly Hugging Face mirror, populated by the export workflow when the
 * repo has an HF_TOKEN secret. Tried first (browser builds can't read GitHub
 * release assets); the GitHub release index is the fallback.
 */
export const HF_MIRROR_BASE = 'https://huggingface.co/Aralario/tamias-zenodo-liver-models/resolve/main';
export const MODEL_INDEX_URLS = [`${HF_MIRROR_BASE}/zenodo-models-index.json`, MODEL_INDEX_URL];

export type ModelStatus = 'ok' | 'failed' | 'unpublished';

export interface CatalogModel {
  id: string;
  name: string;
  family: 'lightningmedseg3d' | 'nnunet';
  arch: string;
  /** 'cnn' | 'transformer' — for grouping in comparisons. */
  kind: 'cnn' | 'transformer';
  zenodoRecord: string;
  zenodoUrl: string;
  doi: string;
  /** File inside the Zenodo record the ONNX was exported from. */
  sourceFile: string;
  license: string;
  citation: string;
  codeUrl: string;
  /** Catalogue dataset ids this model was trained on (in-distribution). */
  trainedOn: string[];
  onnxUrl: string;
  manifestUrl: string;
  /** GitHub-release URLs kept as a fallback when a CORS mirror is preferred. */
  fallbackOnnxUrl?: string;
  fallbackManifestUrl?: string;
  /** Filled from the release index. */
  sha256?: string;
  bytes?: number;
  labels?: Record<number, string>;
  parity?: { maxAbsDiff: number; ok: boolean };
  status: ModelStatus;
  error?: string | null;
}

export type DatasetAccess =
  | {
      kind: 'idc-s3';
      /** IDC collection id (lower-case, underscores). */
      collectionId: string;
      cases: IdcCase[];
    }
  | { kind: 'download'; url: string; sizeBytes?: number; note: string };

export interface IdcCase {
  caseId: string;
  patientId: string;
  /** IDC crdc_series_uuid → S3 prefix of the CT series. */
  ctSeriesUuid: string;
  /** IDC crdc_series_uuid of the DICOM-SEG ground truth. */
  segSeriesUuid: string;
  ctSeriesInstanceUid?: string;
  segSeriesInstanceUid?: string;
  /**
   * HCC-TACE-Seg CT series hold 1–3 contrast phases at the same slice
   * positions; only this acquisition is loaded (the portal-venous-most one
   * that fully contains the SEG).
   */
  acquisitionNumber?: number;
  description?: string;
}

export interface CatalogDataset {
  id: string;
  name: string;
  modality: 'CT';
  subjects: number;
  license: string;
  doi: string;
  pageUrl: string;
  citation: string;
  /** Ground-truth structures available. */
  groundTruth: string[];
  /**
   * Label values of the dataset's ground truth that map to the canonical
   * catalogue label space (1 liver, 2 tumour). Everything else is background.
   * IDC cases are already canonical after the DICOM-SEG mapping.
   */
  gtLabels: { liver: number[]; tumour: number[] };
  access: DatasetAccess;
  description: string;
}

const LMS3D_CITATION =
  'Fdez-González M, Nodar-Corral L, Fdez-Vidal XR, Estévez-Fernández S, Comesaña Figueroa E. ' +
  'LightningMedSeg3D: Trained Weights of Nine 3D Medical Image Segmentation Networks on BTCV and ' +
  'MSD Task03 (Liver). Zenodo, 2026. doi:10.5281/zenodo.21037952';

/** BTCV 13-organ label map of the LightningMedSeg3D checkpoints (from the release index). */
const BTCV_LABELS: Record<number, string> = {
  0: 'background',
  1: 'spleen',
  2: 'right_kidney',
  3: 'left_kidney',
  4: 'gallbladder',
  5: 'esophagus',
  6: 'liver',
  7: 'stomach',
  8: 'aorta',
  9: 'inferior_vena_cava',
  10: 'portal_and_splenic_veins',
  11: 'pancreas',
  12: 'right_adrenal_gland',
  13: 'left_adrenal_gland',
};
/** nnU-Net Dataset006_Liver label map, verbatim from its dataset.json ('tumsomething' is the authors' name). */
const NNUNET_LIVER_LABELS: Record<number, string> = {
  0: 'background',
  1: 'spleen',
  2: 'kidneys',
  3: 'pancreas',
  4: 'stomach',
  5: 'heart',
  6: 'duodenum',
  7: 'tumsomething',
  8: 'liver',
  9: 'tumor',
};

const LMS3D_ARCHS: Array<{ arch: string; name: string; kind: 'cnn' | 'transformer' }> = [
  { arch: 'unet', name: '3D U-Net', kind: 'cnn' },
  { arch: 'vnet', name: '3D V-Net', kind: 'cnn' },
  { arch: 'resunet', name: '3D Res-UNet', kind: 'cnn' },
  { arch: 'attention_unet', name: '3D Attention U-Net', kind: 'cnn' },
  { arch: 'unetpp', name: '3D UNet++', kind: 'cnn' },
  { arch: 'unetr', name: 'UNETR', kind: 'transformer' },
  { arch: 'swin_unetr', name: 'SwinUNETR', kind: 'transformer' },
  { arch: 'medformer', name: 'MedFormer 3D', kind: 'transformer' },
  { arch: 'segformer', name: 'SegFormer 3D', kind: 'transformer' },
];

function assetUrls(id: string): { onnxUrl: string; manifestUrl: string } {
  return { onnxUrl: `${MODEL_RELEASE_BASE}/${id}.onnx`, manifestUrl: `${MODEL_RELEASE_BASE}/${id}.json` };
}

export const CATALOG_MODELS: readonly CatalogModel[] = [
  ...LMS3D_ARCHS.map(
    ({ arch, name, kind }): CatalogModel => ({
      id: `lms3d_${arch}`,
      name: `LightningMedSeg3D ${name} (BTCV 13-organ)`,
      family: 'lightningmedseg3d',
      arch,
      kind,
      zenodoRecord: '21037952',
      zenodoUrl: 'https://zenodo.org/records/21037952',
      doi: '10.5281/zenodo.21037952',
      sourceFile: `${arch}.pth`,
      license: 'CC-BY-4.0 (weights) · AGPL-3.0 (code)',
      citation: LMS3D_CITATION,
      codeUrl: 'https://github.com/Removirt/LightningMedSeg3D',
      // The Zenodo checkpoints are the BTCV 13-organ models (liver = label 6, no tumour class).
      trainedOn: ['btcv'],
      ...assetUrls(`lms3d_${arch}`),
      labels: BTCV_LABELS,
      status: 'unpublished',
    })
  ),
  {
    id: 'nnunet_liver_lits',
    name: 'nnU-Net v2 liver + lesions (LiTS 2017)',
    family: 'nnunet',
    arch: 'nnunet_3d_fullres',
    kind: 'cnn',
    zenodoRecord: '11582728',
    zenodoUrl: 'https://zenodo.org/records/11582728',
    doi: '10.5281/zenodo.11582728',
    sourceFile: 'Dataset006_Liver.zip',
    license: 'CC-BY-4.0 (weights) · Apache-2.0 (code)',
    citation:
      'Murugesan GK, Van Oss J, McCrumb D. Pretrained model for 3D semantic image segmentation of ' +
      'the liver and liver lesions from CT scan (nnU-Net v2, LiTS 2017). Zenodo, 2024. ' +
      'doi:10.5281/zenodo.11582728',
    codeUrl: 'https://github.com/MIC-DKFZ/nnUNet',
    trainedOn: ['msd-task03-liver'],
    ...assetUrls('nnunet_liver_lits'),
    labels: NNUNET_LIVER_LABELS,
    status: 'unpublished',
  },
];

export const CATALOG_DATASETS: readonly CatalogDataset[] = [
  {
    id: 'hcc-tace-seg',
    name: 'HCC-TACE-Seg (TCIA)',
    modality: 'CT',
    subjects: 105,
    license: 'CC-BY-4.0',
    doi: '10.7937/TCIA.5FNA-0924',
    pageUrl: 'https://www.cancerimagingarchive.net/collection/hcc-tace-seg/',
    citation:
      'Moawad AW, Fuentes D, Morshid A, et al. Multimodality annotated HCC cases with and without ' +
      'advanced imaging segmentation [Data set]. The Cancer Imaging Archive, 2021. ' +
      'doi:10.7937/TCIA.5FNA-0924',
    groundTruth: ['liver', 'tumor'],
    gtLabels: { liver: [1], tumour: [2] },
    access: {
      kind: 'idc-s3',
      collectionId: 'hcc_tace_seg',
      // QC'd subset: GT inside CT, single annotated grid, portal-venous phase.
      // Skipped: HCC_001 (SEG/CT slice mismatch), 008/010/011 (phases on
      // different z-grids), 012 (arterial only). IDC series UUIDs change when
      // IDC revises a series; SeriesInstanceUIDs are kept for re-resolution.
      cases: [
      {
        caseId: 'HCC_002',
        patientId: 'HCC_002',
        ctSeriesUuid: '463d9b31-b4b6-4b01-897d-209ef1770324',
        segSeriesUuid: 'fdd409a9-54d8-481c-bba3-28c3833007bc',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.291108858467809891631011685789',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.737.1600928582.74386',
        acquisitionNumber: 2,
        description: 'Recon 2: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_003',
        patientId: 'HCC_003',
        ctSeriesUuid: '0f198f98-6b02-4639-932c-1660791a1891',
        segSeriesUuid: '0daa5e91-9799-4c1c-bcce-2907ec27a07f',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.281650679207816520863173918688',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.106355502486885782622426045632',
        acquisitionNumber: 2,
        description: 'Recon 2: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_004',
        patientId: 'HCC_004',
        ctSeriesUuid: 'b009d1ee-15c9-4bad-ac04-201c8b58ac19',
        segSeriesUuid: '36232fd0-f272-469d-9aac-b7aef5a374ea',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.285388762605622963541285440661',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.773.1600928601.639561',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_005',
        patientId: 'HCC_005',
        ctSeriesUuid: '9e3e7ce3-fb19-45d9-b278-d12ee5be003d',
        segSeriesUuid: '21562084-d672-48f3-80e8-7b52944d25b2',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.183855053468714701811489585837',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.791.1600928608.406660',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_006',
        patientId: 'HCC_006',
        ctSeriesUuid: 'e9c83837-1ad7-4c8a-8087-54b953e1e8ad',
        segSeriesUuid: 'a10dd44a-b1d5-4036-8c39-3bb1968e3604',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.169644075146766664505907245033',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.809.1600928614.958134',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_007',
        patientId: 'HCC_007',
        ctSeriesUuid: 'cb1fd5fe-1fbb-47a4-947f-b8ab4b3b8a4e',
        segSeriesUuid: 'a45a40a1-6bc3-42a0-9704-6f80658709a9',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.146103304273906855574595828011',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.827.1600928625.439839',
        acquisitionNumber: 3,
        description: 'Recon 2: LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_009',
        patientId: 'HCC_009',
        ctSeriesUuid: '705d51cc-51a9-497d-9558-4ada63b1f9a0',
        segSeriesUuid: '3fda7848-7291-4c72-9fd9-b0d7c31615ae',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.317807071078652818055139883135',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.863.1600928649.191221',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (C/A/P) · acq 3',
      },
      {
        caseId: 'HCC_013',
        patientId: 'HCC_013',
        ctSeriesUuid: '65db8ce9-1cdd-4576-aeab-30007213a880',
        segSeriesUuid: 'a46cf2ec-3f3d-45c2-a431-2fdd5a195797',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.489872120073574349734745881040',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.935.1600928687.569940',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_014',
        patientId: 'HCC_014',
        ctSeriesUuid: 'c405524b-ac99-471d-a408-8febe47b6bf6',
        segSeriesUuid: 'e8309777-003d-466c-b08a-effdd00d1fad',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.556779495579839917640350540451',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.953.1600928692.569229',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_015',
        patientId: 'HCC_015',
        ctSeriesUuid: 'ae1d957e-8130-4138-81ee-527bbc2d4dc5',
        segSeriesUuid: '6223b771-010a-47c8-b238-9a35083d0051',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.233008122906404934405393444492',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.971.1600928697.454558',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      ],
    },
    description:
      'Multiphase contrast CT of 105 HCC patients before TACE (MD Anderson) with curated liver, ' +
      'tumour and vessel DICOM-SEG. External test set for every catalogue model — none were ' +
      'trained on it. Pulled directly from TCIA via the NCI Imaging Data Commons public bucket.',
  },
  {
    id: 'btcv',
    name: 'BTCV multi-organ abdominal CT',
    modality: 'CT',
    subjects: 90,
    license: 'CC-BY-4.0',
    doi: '10.5281/zenodo.1169361',
    pageUrl: 'https://zenodo.org/records/1169361',
    citation:
      'Gibson E, Giganti F, Hu Y, et al. Multi-organ Abdominal CT Reference Standard Segmentations (1.0). ' +
      'Zenodo, 2018. doi:10.5281/zenodo.1169361',
    groundTruth: ['liver', 'spleen', 'kidney', 'pancreas', 'stomach', 'gallbladder', 'esophagus', 'duodenum'],
    // BTCV label map: 1 spleen, 2 right kidney, … 6 liver; no tumour class.
    gtLabels: { liver: [6], tumour: [] },
    access: {
      kind: 'download',
      url: 'https://zenodo.org/records/1169361',
      note: 'Training distribution of the LightningMedSeg3D checkpoints (in-distribution reference for them).',
    },
    description:
      'Multi-organ reference segmentations (TCIA Pancreas-CT + BTCV). In-distribution for the nine ' +
      'LightningMedSeg3D checkpoints; external for nnU-Net.',
  },
  {
    id: 'msd-task03-liver',
    name: 'MSD Task03 Liver (LiTS)',
    modality: 'CT',
    subjects: 201,
    license: 'CC-BY-SA-4.0',
    doi: '10.1038/s41467-022-30695-9',
    pageUrl: 'http://medicaldecathlon.com/',
    citation:
      'Antonelli M, Reinke A, Bakas S, et al. The Medical Segmentation Decathlon. Nat Commun 13, 4128 ' +
      '(2022). Bilic P, et al. The Liver Tumor Segmentation Benchmark (LiTS). Med Image Anal 84 (2023).',
    groundTruth: ['liver', 'tumor'],
    gtLabels: { liver: [1], tumour: [2] },
    access: {
      kind: 'download',
      url: 'https://msd-for-monai.s3-us-west-2.amazonaws.com/Task03_Liver.tar',
      sizeBytes: 28_925_891_584,
      note: 'Training distribution of the nnU-Net model (LiTS); external for the BTCV-trained LightningMedSeg3D nets. 29 GB tar — extract a few cases locally and load the NIfTI files.',
    },
    description:
      'Portal-venous CT with liver + tumour labels (LiTS). In-distribution for the nnU-Net model, ' +
      'external for the BTCV-trained LightningMedSeg3D nets.',
  },
];

export function datasetsForModel(model: CatalogModel): CatalogDataset[] {
  // Every model is paired with HCC-TACE-Seg (external) plus its training sets.
  return CATALOG_DATASETS.filter((d) => d.id === 'hcc-tace-seg' || model.trainedOn.includes(d.id));
}

export function modelsForDataset(dataset: CatalogDataset): CatalogModel[] {
  if (dataset.id === 'hcc-tace-seg') return [...CATALOG_MODELS];
  return CATALOG_MODELS.filter((m) => m.trainedOn.includes(dataset.id));
}

/* ------------------------------------------------------------------ */
/* Release index                                                       */
/* ------------------------------------------------------------------ */

export interface ModelIndexEntry {
  id: string;
  file: string;
  manifest?: string;
  bytes?: number;
  sha256?: string;
  status: 'ok' | 'failed';
  error?: string | null;
  labels?: Record<number, string>;
  parity?: { maxAbsDiff: number; ok: boolean };
  trainedOn?: string;
  license?: string;
}

export interface ModelIndex {
  release: string;
  models: ModelIndexEntry[];
  /** CORS-friendly mirror bases (Hugging Face only), preferred over the release. */
  mirrors: string[];
}

// Pinned to the project's own HF repo: the index may choose the revision, never the owner.
const MIRROR_RE = /^https:\/\/huggingface\.co\/Aralario\/tamias-zenodo-liver-models\/resolve\/[A-Za-z0-9._-]+$/;

export function isValidMirror(base: unknown): base is string {
  return typeof base === 'string' && MIRROR_RE.test(base);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function parseModelIndex(raw: unknown): ModelIndex {
  if (!isObj(raw) || raw.schema !== 'tamias.model-index.v1') {
    throw new Error('Model index: schema must be "tamias.model-index.v1".');
  }
  if (!Array.isArray(raw.models)) throw new Error('Model index: "models" must be an array.');
  const models = raw.models.map((m, i): ModelIndexEntry => {
    if (!isObj(m)) throw new Error(`Model index: models[${i}] must be an object.`);
    if (typeof m.id !== 'string' || !m.id) throw new Error(`Model index: models[${i}].id missing.`);
    if (typeof m.file !== 'string') throw new Error(`Model index: ${m.id}.file missing.`);
    if (m.status !== 'ok' && m.status !== 'failed') {
      throw new Error(`Model index: ${m.id}.status must be "ok" or "failed".`);
    }
    if (m.sha256 !== undefined && (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256))) {
      throw new Error(`Model index: ${m.id}.sha256 must be 64 hex chars.`);
    }
    let labels: Record<number, string> | undefined;
    if (isObj(m.labels)) {
      labels = {};
      for (const [k, v] of Object.entries(m.labels)) {
        if (typeof v === 'string' && /^\d+$/.test(k)) labels[Number(k)] = v;
      }
    }
    const parity =
      isObj(m.parity) && typeof m.parity.maxAbsDiff === 'number'
        ? { maxAbsDiff: m.parity.maxAbsDiff, ok: m.parity.ok === true }
        : undefined;
    return {
      id: m.id,
      file: m.file,
      manifest: typeof m.manifest === 'string' ? m.manifest : undefined,
      bytes: typeof m.bytes === 'number' ? m.bytes : undefined,
      sha256: typeof m.sha256 === 'string' ? m.sha256.toLowerCase() : undefined,
      status: m.status,
      error: typeof m.error === 'string' ? m.error : null,
      labels,
      parity,
      trainedOn: typeof m.trainedOn === 'string' ? m.trainedOn : undefined,
      license: typeof m.license === 'string' ? m.license : undefined,
    };
  });
  const mirrors = Array.isArray(raw.mirrors) ? raw.mirrors.filter(isValidMirror) : [];
  return { release: typeof raw.release === 'string' ? raw.release : MODEL_RELEASE_TAG, models, mirrors };
}

/**
 * Overlay published-release facts onto the static catalogue. Only ids the
 * catalogue already knows are accepted — the index can never inject a new
 * download URL. Entries missing from the index are `unpublished`.
 */
export function mergeModelIndex(models: readonly CatalogModel[], index: ModelIndex): CatalogModel[] {
  const byId = new Map(index.models.map((m) => [m.id, m]));
  return models.map((m) => {
    const e = byId.get(m.id);
    if (!e) return { ...m, status: 'unpublished' as const };
    // A mirror is only trusted for entries whose bytes are pinned by sha256.
    const mirror = e.sha256 ? index.mirrors[0] : undefined;
    const urls = mirror
      ? {
          onnxUrl: `${mirror}/${m.id}.onnx`,
          manifestUrl: `${mirror}/${m.id}.json`,
          fallbackOnnxUrl: m.onnxUrl,
          fallbackManifestUrl: m.manifestUrl,
        }
      : {};
    return {
      ...m,
      ...urls,
      sha256: e.sha256 ?? m.sha256,
      bytes: e.bytes ?? m.bytes,
      labels: e.labels ?? m.labels,
      parity: e.parity ?? m.parity,
      license: e.license ?? m.license,
      status: e.status,
      error: e.error ?? null,
    };
  });
}
