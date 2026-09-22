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
  access: DatasetAccess;
  description: string;
}

const LMS3D_CITATION =
  'Fdez-González M, Nodar-Corral L, Fdez-Vidal XR, Estévez-Fernández S, Comesaña Figueroa E. ' +
  'LightningMedSeg3D: Trained Weights of Nine 3D Medical Image Segmentation Networks on BTCV and ' +
  'MSD Task03 (Liver). Zenodo, 2026. doi:10.5281/zenodo.21037952';

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
      name: `LightningMedSeg3D ${name} (liver)`,
      family: 'lightningmedseg3d',
      arch,
      kind,
      zenodoRecord: '21037952',
      zenodoUrl: 'https://zenodo.org/records/21037952',
      doi: '10.5281/zenodo.21037952',
      sourceFile: `${arch}.pth`,
      license: 'See Zenodo record (weights) · AGPL-3.0 (code)',
      citation: LMS3D_CITATION,
      codeUrl: 'https://github.com/Removirt/LightningMedSeg3D',
      trainedOn: ['msd-task03-liver'],
      ...assetUrls(`lms3d_${arch}`),
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
    license: 'See Zenodo record',
    citation:
      'Murugesan GK, Van Oss J, McCrumb D. Pretrained model for 3D semantic image segmentation of ' +
      'the liver and liver lesions from CT scan (nnU-Net v2, LiTS 2017). Zenodo, 2024. ' +
      'doi:10.5281/zenodo.11582728',
    codeUrl: 'https://github.com/MIC-DKFZ/nnUNet',
    trainedOn: ['msd-task03-liver'],
    ...assetUrls('nnunet_liver_lits'),
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
    access: { kind: 'idc-s3', collectionId: 'hcc_tace_seg', cases: [] },
    description:
      'Multiphase contrast CT of 105 HCC patients before TACE (MD Anderson) with curated liver, ' +
      'tumour and vessel DICOM-SEG. External test set for every catalogue model — none were ' +
      'trained on it. Pulled directly from TCIA via the NCI Imaging Data Commons public bucket.',
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
    access: {
      kind: 'download',
      url: 'https://msd-for-monai.s3-us-west-2.amazonaws.com/Task03_Liver.tar',
      sizeBytes: 28_925_891_584,
      note: 'Training distribution of every catalogue model (in-distribution reference). 29 GB tar — extract a few cases locally and load the NIfTI files.',
    },
    description:
      'Portal-venous CT with liver + tumour labels. The catalogue models were trained on this ' +
      'data, so scores here are an in-distribution reference, not a generalisation estimate.',
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

const MIRROR_RE =
  /^https:\/\/huggingface\.co\/[A-Za-z0-9][A-Za-z0-9._-]*\/tamias-zenodo-liver-models\/resolve\/[A-Za-z0-9._-]+$/;

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
    const mirror = index.mirrors[0];
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
