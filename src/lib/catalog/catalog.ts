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
import { readHfSettings } from './hf-settings';

export const MODEL_RELEASE_BASE = `https://github.com/ArioMoniri/semikap/releases/download/${MODEL_RELEASE_TAG}`;
export const MODEL_INDEX_URL = `${MODEL_RELEASE_BASE}/zenodo-models-index.json`;
/**
 * CORS-friendly Hugging Face mirror, populated by the export workflow when the
 * repo has an HF_TOKEN secret. Tried first (browser builds can't read GitHub
 * release assets); the GitHub release index is the fallback.
 */
/**
 * Hugging Face account that owns the mirror. Forks set VITE_HF_MIRROR_OWNER at build time
 * (the account of their own HF_TOKEN secret); integrity never depends on it — every file
 * is still checked against the pinned sha256.
 */
export const HF_MIRROR_OWNER = mirrorOwner(
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_HF_MIRROR_OWNER
);
export function mirrorOwner(raw: string | undefined): string {
  const v = raw?.trim();
  return v && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v) ? v : 'Aralario';
}
export const HF_MIRROR_BASE = hfMirrorBase(HF_MIRROR_OWNER);
export function hfMirrorBase(owner: string): string {
  return `https://huggingface.co/${owner}/tamias-zenodo-liver-models/resolve/main`;
}
/** The user's own mirror account (Catalogue → Hugging Face settings) or the build default. */
export function activeMirrorOwner(): string {
  return readHfSettings().mirrorOwner ?? HF_MIRROR_OWNER;
}
/** Index locations, the active mirror first (browser builds can't read GitHub release assets). */
export function modelIndexUrls(): string[] {
  return [`${hfMirrorBase(activeMirrorOwner())}/zenodo-models-index.json`, MODEL_INDEX_URL];
}
export const MODEL_INDEX_URLS = [`${HF_MIRROR_BASE}/zenodo-models-index.json`, MODEL_INDEX_URL];

export type ModelStatus = 'ok' | 'failed' | 'unpublished';

export interface CatalogModel {
  id: string;
  name: string;
  /** 'imported' = added by the user from a Zenodo record (see zenodo.ts). */
  family: 'lightningmedseg3d' | 'nnunet' | 'imported';
  arch: string;
  /** 'cnn' | 'transformer' — for grouping in comparisons ('unknown' for imported ONNX). */
  kind: 'cnn' | 'transformer' | 'unknown';
  zenodoRecord: string;
  zenodoUrl: string;
  doi: string;
  /** File inside the Zenodo record the ONNX was exported from. */
  sourceFile: string;
  /** md5 / sha256 of that source file (conversion report / release index). */
  sourceMd5?: string;
  sourceSha256?: string;
  license: string;
  citation: string;
  codeUrl: string;
  /** Catalogue dataset ids this model was trained on (in-distribution). */
  trainedOn: string[];
  /** Provenance caveat printed in the benchmark report's Methods. */
  methodsNote?: string;
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
  /** Set on models the user imported from a Zenodo record. */
  imported?: {
    recordId: string;
    /** 'onnx' = ONNX + manifest shipped in the record; 'verified-conversion' = checkpoint md5 matches a published export. */
    via: 'onnx' | 'verified-conversion';
    note: string;
  };
}

export type DatasetAccess =
  | {
      kind: 'idc-s3';
      /** IDC collection id (lower-case, underscores). */
      collectionId: string;
      cases: IdcCase[];
    }
  | { kind: 'download'; url: string; sizeBytes?: number; note: string }
  /** Cases the user imported (local DICOM CT + SEG, IDC series ids); see imports.ts. */
  | { kind: 'imported'; note: string };

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
   * positions; only this acquisition is loaded (the most venous available
   * one that fully contains the SEG).
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
  /** Reference-standard / acquisition caveats printed in the benchmark report's Methods. */
  methodsNote?: string;
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

/**
 * sha256 + size of the published fp32 ONNX exports (release zenodo-models-v1), pinned so
 * downloads are verified and records can be matched to catalogue models even when the
 * release index is unreachable (e.g. CORS in the browser build).
 */
const PUBLISHED_ONNX: Record<string, { sha256: string; bytes: number }> = {
  lms3d_attention_unet: { sha256: '4f511be83e5312790c947b73b9f0550b2c081f3713d4c2e4d39fa8edf118ac21', bytes: 162743878 },
  lms3d_medformer: { sha256: '7587ebf9249b1a2bc4e22df663914ab7cab9f393912ce7f738cc2038396d0ab5', bytes: 155209527 },
  lms3d_resunet: { sha256: 'a84bbe8ba2ce5861e615a04b64edbf9a3aa5278080be9d5b61e62574cbfa4ab0', bytes: 162308644 },
  lms3d_segformer: { sha256: '28197e635cf9f796e18109fcf0638ce0caa71515295633e3474bfc5280e752d9', bytes: 18091889 },
  lms3d_swin_unetr: { sha256: 'f0a017977dfa920a372b02119e316882b39013abc2466219950c5ca12bca1933', bytes: 143378796 },
  lms3d_unet: { sha256: 'd6e9842419ad1d02e62ca0998a7820b44514794f4eda144507fc141c6e8240fb', bytes: 65096212 },
  lms3d_unetpp: { sha256: 'bb8556f757e0d734ac45f2ccf6f1ceea52e8f3d8b14a4c0ff650269980569d36', bytes: 17870378 },
  lms3d_unetr: { sha256: '0b50545c96fb6d5438594c774e78be740854c04bdfe859158e8011f2fcaf8122', bytes: 371334154 },
  lms3d_vnet: { sha256: '0da7b5f8f2f4cc64dffa0cec6ea6e8343db5615d5a3d34395dc739d65686ecc3', bytes: 182622539 },
  nnunet_liver_lits: { sha256: '803176c487041d9186f757e9f3b660d428a158a44a1d2207fe5c182643efe5e7', bytes: 124809221 },
};

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
      methodsNote:
        'LightningMedSeg3D (Zenodo 21037952): the record lists BTCV and MSD Task03 weights in its metadata but ships ' +
        'only the BTCV 13-organ checkpoints (identified by sha256), so all nine nets are BTCV models (liver = 6, no ' +
        'tumour class) and are scored on whole liver only.',
      ...assetUrls(`lms3d_${arch}`),
      ...PUBLISHED_ONNX[`lms3d_${arch}`],
      labels: BTCV_LABELS,
      status: 'unpublished',
    })
  ),
  {
    id: 'nnunet_liver_lits',
    name: 'nnU-Net v2 liver + lesions (Dataset006_Liver)',
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
      'the liver and liver lesions from CT scan (nnU-Net v2 Dataset006_Liver; training data stated as ' +
      'LiTS 2017). Zenodo, 2024. doi:10.5281/zenodo.11582728. Single fold (fold 0) exported, no ensemble; ' +
      'its 10 output classes (abdominal organs, liver, tumour) imply organ labels beyond LiTS.',
    codeUrl: 'https://github.com/MIC-DKFZ/nnUNet',
    trainedOn: ['msd-task03-liver'],
    methodsNote:
      'nnU-Net v2 Dataset006_Liver (Zenodo 11582728, BAMF Health): training data stated as LiTS 2017, of which MSD ' +
      'Task03 imagesTr is a subset (MSD scores for this model are resubstitution); fold 0 only, no ensemble, no ' +
      'nnU-Net post-processing. Its 10-class output (organs, liver 8, tumour 9, an unnamed class 7 left unscored) ' +
      'implies additional organ labels; overlap of its training data with HCC-TACE-Seg cannot be fully excluded.',
    ...assetUrls('nnunet_liver_lits'),
    ...PUBLISHED_ONNX.nnunet_liver_lits,
    labels: NNUNET_LIVER_LABELS,
    status: 'unpublished',
  },
];

/**
 * Ensemble entries (manifest lists member ONNX ids + sha256; no ONNX of their own). Kept out of
 * CATALOG_MODELS: the in-app catalogue loader, benchmark kits and Zenodo-import tables handle
 * single-ONNX models only, so an ensemble is run through the headless runner / inference worker
 * (members passed as memberBytes) until the catalogue loads ensemble members.
 */
export const CATALOG_ENSEMBLES: readonly CatalogModel[] = [
  {
    id: 'nnunet_liver_lits_ens5',
    name: 'nnU-Net v2 liver + lesions, 5-fold ensemble + mirror TTA (Dataset006_Liver)',
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
      'the liver and liver lesions from CT scan (nnU-Net v2 Dataset006_Liver; training data stated as ' +
      'LiTS 2017). Zenodo, 2024. doi:10.5281/zenodo.11582728. All 5 folds exported to ONNX and ensembled ' +
      'with mirror test-time augmentation.',
    codeUrl: 'https://github.com/MIC-DKFZ/nnUNet',
    trainedOn: ['msd-task03-liver'],
    methodsNote:
      'nnU-Net v2 Dataset006_Liver (Zenodo 11582728, BAMF Health), run in nnU-Net\'s published inference ' +
      'configuration: the 5 cross-validation folds (fold 0 = nnunet_liver_lits, folds 1–4 = nnunet_liver_lits_f1…f4, ' +
      'each exported to ONNX and parity-checked on its own) as an ensemble with mirroring test-time augmentation ' +
      '(each 128³ tile run by every fold on all 8 flips over the 3 spatial axes, flipped back; logits ' +
      'averaged as in nnUNetv2_predict, then Gaussian-blended). No nnU-Net post-processing. Training data stated as LiTS 2017, ' +
      'of which MSD Task03 imagesTr is a subset (MSD scores are resubstitution); the 10-class output (organs, liver 8, ' +
      'tumour 9, an unnamed class 7 left unscored) implies additional organ labels; overlap with HCC-TACE-Seg cannot ' +
      'be fully excluded.',
    // No PUBLISHED_ONNX pin: an ensemble has no ONNX of its own. The release index's `ensembles` entry supplies
    // its sha256 (computed over the member sha256s) and each member's pin; nnunet_liver_lits_ens5.json lists them.
    ...assetUrls('nnunet_liver_lits_ens5'),
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
      // All 82 of 105 patients that pass the pre-specified QC of
      // scripts/bench/data/fetch_hcc_tace_seg.py (flow log: scripts/bench/data/hcc_flow.csv).
      // Excluded: 16 acquisitions on different z-grids (annotated grid/phase ambiguous; 1 of
      // them also arterial-only, e.g. HCC_001/008/010/011), 5 arterial-only (e.g. HCC_012),
      // 1 SEG not fully inside the CT, 1 SEG without a CT reference (HCC_048). The first 10
      // (HCC_002…HCC_015) are the original benchmark set. IDC series UUIDs change when IDC
      // revises a series; SeriesInstanceUIDs are kept for re-resolution. HCC_065 has no
      // AcquisitionNumber (single phase), so the loader keeps the whole series.
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
      {
        caseId: 'HCC_016',
        patientId: 'HCC_016',
        ctSeriesUuid: '82858106-9137-4058-9367-23850386455f',
        segSeriesUuid: '8f6c5d3e-b613-448c-a1d2-61629734f112',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.318739454056625943716212501955',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.989.1600928704.681626',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_017',
        patientId: 'HCC_017',
        ctSeriesUuid: '4fef7115-a89b-4e4e-a887-26cf84f9a6eb',
        segSeriesUuid: '9b7610db-d977-4cea-a34b-f27de6e3e543',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.172517341095680731665822868712',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.41.1604860085.518229',
        acquisitionNumber: 2,
        description: 'Recon 3: 3 PHASE LIVER (ABD) · acq 2',
      },
      {
        caseId: 'HCC_018',
        patientId: 'HCC_018',
        ctSeriesUuid: '77645d96-1019-4593-8dca-70834dc74071',
        segSeriesUuid: '44562f26-0e7e-494c-9a18-198f077b3268',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.120561979182042529441155251879',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1025.1600928712.684912',
        acquisitionNumber: 2,
        description: 'LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_019',
        patientId: 'HCC_019',
        ctSeriesUuid: '0aec27f1-2c9c-4abf-8109-e5a7e2194e31',
        segSeriesUuid: '11003b29-1200-40a0-841c-42e215eb4794',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.991595515813772991981994577552',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1043.1600928717.799505',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_020',
        patientId: 'HCC_020',
        ctSeriesUuid: '87d98c68-bd40-4bc5-a452-0685c56adbc7',
        segSeriesUuid: '7a356c40-eba6-406b-90f8-257ad84b3752',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.316337432171323817598369252625',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1061.1600928724.100970',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_021',
        patientId: 'HCC_021',
        ctSeriesUuid: '8e67d3a2-4265-4dac-8faa-d954578d098a',
        segSeriesUuid: '2af6530a-68d1-428e-b38a-240668c32b5f',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.144578916972880946591843596104',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1079.1600928730.306403',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_022',
        patientId: 'HCC_022',
        ctSeriesUuid: '45d8a313-0022-46fc-b3dc-58cd48ce841f',
        segSeriesUuid: 'ca093ac0-ff56-4ebc-898b-b54daecac7be',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.146824328095737964043005973177',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1097.1600928735.299086',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_024',
        patientId: 'HCC_024',
        ctSeriesUuid: '662105e5-8b77-45b5-b99e-7c54cafd89d1',
        segSeriesUuid: 'c05152f6-41b5-420f-b554-0327ece9839b',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.862139468445868861364945169913',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1133.1600928744.768622',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_025',
        patientId: 'HCC_025',
        ctSeriesUuid: 'f77f6519-dd9b-4c89-83c8-8b13d0f0668a',
        segSeriesUuid: 'a48e724f-b1d2-4173-b1b1-a94fa14125b5',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.663753513037670993657925664464',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1151.1600928749.837607',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_026',
        patientId: 'HCC_026',
        ctSeriesUuid: 'b7429039-6284-42db-ac3f-8bbf18bc35a2',
        segSeriesUuid: 'debea2b1-9253-4a40-953f-b379199621ba',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.169638974724763194322235352789',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1169.1600928754.915421',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_027',
        patientId: 'HCC_027',
        ctSeriesUuid: '18066828-2353-49c5-8360-ced8c6e74e99',
        segSeriesUuid: '03ffa4cd-8b8b-425f-87b0-480cbafa8b14',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.203195937357017832500975199162',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1187.1600928760.297362',
        acquisitionNumber: 3,
        description: 'nan · acq 3',
      },
      {
        caseId: 'HCC_028',
        patientId: 'HCC_028',
        ctSeriesUuid: '55ad1938-40a1-4eed-a7da-d314bf254ab6',
        segSeriesUuid: 'f34a2125-7151-4e8c-8cc0-b2faf03a49db',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.258454521298654882724513564832',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1205.1600928767.611681',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_029',
        patientId: 'HCC_029',
        ctSeriesUuid: 'cb5cee02-e8d4-4bbf-a9da-0dd6ab72263e',
        segSeriesUuid: '75f6c577-9fc0-4d02-996d-b05fc49ec045',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.874855670505554886590797381965',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1223.1600928773.325329',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_030',
        patientId: 'HCC_030',
        ctSeriesUuid: '8aaa0d11-8efd-45b0-8258-e47bc943da25',
        segSeriesUuid: 'ea22050d-7fd1-4719-b236-e72a1679d75f',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.252519330659724928966516416186',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1241.1600928784.337188',
        acquisitionNumber: 3,
        description: 'Recon 2: LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_031',
        patientId: 'HCC_031',
        ctSeriesUuid: 'cd2f5f4c-3eb6-45e5-9f2c-ca8c93b679b7',
        segSeriesUuid: '4ff72120-8ca2-4572-a689-4aeafe769500',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.228468051025110954617213284185',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1259.1600928790.366488',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_032',
        patientId: 'HCC_032',
        ctSeriesUuid: '9fb5d350-94e9-4666-a84d-14f5e47f68c6',
        segSeriesUuid: 'cf27609e-c548-4e6d-92ea-db1fc734aa19',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.115558995063414845036761741321',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1277.1600928794.774216',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_034',
        patientId: 'HCC_034',
        ctSeriesUuid: '4af3bc9f-37fc-42fe-b82f-6ac4b41c6212',
        segSeriesUuid: '16a227de-9b5d-4ea5-a4a5-06f977e650ef',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.158798556021120706786120139349',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1313.1600928804.952091',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_035',
        patientId: 'HCC_035',
        ctSeriesUuid: '75982c55-7af3-4d73-9377-5026715ac9dc',
        segSeriesUuid: 'c5c19bc5-b12c-44d0-9c45-57f7a5149b6e',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.872997838377884996253218531168',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1331.1600928811.521743',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_037',
        patientId: 'HCC_037',
        ctSeriesUuid: '882fe15d-8cdf-4796-bf7b-3177fe1c84d4',
        segSeriesUuid: 'efe04bbc-cf15-44f2-86c5-157f77a42e5c',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.127855973635818232365939385060',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1367.1600928823.55520',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_038',
        patientId: 'HCC_038',
        ctSeriesUuid: 'f3dde21b-4166-4cad-bb8a-bd12165477fd',
        segSeriesUuid: '625e9784-b120-4054-95f1-878474cae06e',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.120877865076939710856688132355',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1385.1600928829.82541',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_039',
        patientId: 'HCC_039',
        ctSeriesUuid: 'b588ba95-4960-4a94-b2cc-fd2f9829212b',
        segSeriesUuid: 'ccb21708-7c76-4599-9605-a78efe8fe7eb',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.299285649882589286568338511740',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1403.1600928834.451107',
        acquisitionNumber: 3,
        description: '3 PHASE LIVER (ABD) · acq 3',
      },
      {
        caseId: 'HCC_041',
        patientId: 'HCC_041',
        ctSeriesUuid: 'fb42b33a-3455-4e60-83c2-de0e7f626a96',
        segSeriesUuid: '4c4e259c-893a-4b2d-bd31-64b0d3dd33cc',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.267405854053060362743839359292',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1439.1600928846.741081',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (C/A/P) · acq 3',
      },
      {
        caseId: 'HCC_042',
        patientId: 'HCC_042',
        ctSeriesUuid: '8d42ce41-5f5e-4c44-a24e-63149f2ec7ad',
        segSeriesUuid: 'e433441c-a992-4a47-81f9-3ddb1cd11d1c',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.448173801715414243321174862591',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1457.1600928853.995627',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_043',
        patientId: 'HCC_043',
        ctSeriesUuid: 'be96c481-9dca-499e-a945-051f8454855c',
        segSeriesUuid: '0765deff-9478-43ef-ac1f-bf36200cd265',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.294968180797311382719366551877',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1475.1600928859.239209',
        acquisitionNumber: 3,
        description: 'LIVER 3 PHASE (AP) · acq 3',
      },
      {
        caseId: 'HCC_044',
        patientId: 'HCC_044',
        ctSeriesUuid: '4737e5ee-3667-4879-a069-dc1111100ff6',
        segSeriesUuid: '95762c7d-5aa4-4eb3-869d-09a3d12d2d89',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.237479117274349870965140370228',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1493.1600928864.981382',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_045',
        patientId: 'HCC_045',
        ctSeriesUuid: '4de1261a-8878-4902-9e79-d2d4a8f10077',
        segSeriesUuid: 'b0eeeb6a-95a0-4f9d-b8b6-f0837bfb25e8',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.239675104574255827957236778069',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1511.1600928870.183961',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_046',
        patientId: 'HCC_046',
        ctSeriesUuid: '78e01602-b43b-4385-93f9-0aa2ea471779',
        segSeriesUuid: 'a0151ae2-f17b-4066-b51f-6bbbaab27f22',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.921308362302783253486235882492',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1529.1600928876.254026',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_047',
        patientId: 'HCC_047',
        ctSeriesUuid: '5ab9c6d8-4e17-45c3-9b1c-5e9ac953666a',
        segSeriesUuid: '3253ee0d-093e-4c15-b5f8-ae5805537341',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.116451085904950186258093963163',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1547.1600928882.960477',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_049',
        patientId: 'HCC_049',
        ctSeriesUuid: 'c65fec5c-5eff-4f60-8138-4f74dd60be6e',
        segSeriesUuid: '19b1aba6-606e-40d0-a0a5-cdf02a3b29ca',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.628524805420106513093813472984',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1583.1600928896.703352',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_050',
        patientId: 'HCC_050',
        ctSeriesUuid: 'ff651f33-d346-4521-86f2-a30b56f21a9b',
        segSeriesUuid: '3b3a1118-bc1f-461f-9db3-8491c7316403',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.111222919129839286979978615829',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1601.1600928903.120916',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_051',
        patientId: 'HCC_051',
        ctSeriesUuid: '693be323-588f-40e6-8a94-dcffff40ce54',
        segSeriesUuid: '666db1b6-5b56-4c1b-8dae-51432d4fa6ed',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.168467877926914067122086638555',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1619.1600928909.284416',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER  2PHASE WITH CON · acq 2',
      },
      {
        caseId: 'HCC_052',
        patientId: 'HCC_052',
        ctSeriesUuid: 'c64af72e-bebf-4525-8824-812f2fb294cc',
        segSeriesUuid: '247ed41d-8e42-4c3e-bff5-740a1d71a698',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.212665247771039281214268872539',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1637.1600928917.164975',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_053',
        patientId: 'HCC_053',
        ctSeriesUuid: 'f3f66ca6-6c21-46d0-98f2-26024f6ca186',
        segSeriesUuid: '6d436033-9dce-413a-9c02-fdef42da366e',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.163690222392188722825961848367',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1655.1600928923.28893',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_054',
        patientId: 'HCC_054',
        ctSeriesUuid: 'c93d04f7-2805-4b29-a62d-bb8c04cd7d48',
        segSeriesUuid: 'f34a683e-9310-44da-80e5-7f25f563ec1c',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.139126016454479595137335238798',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1673.1600928929.168302',
        acquisitionNumber: 2,
        description: 'C-A-P · acq 2',
      },
      {
        caseId: 'HCC_055',
        patientId: 'HCC_055',
        ctSeriesUuid: '3484233a-92f0-40b2-b3b7-5899e986a8f9',
        segSeriesUuid: '94edb447-7af7-439d-af05-9fc0f93c807f',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.225555660367207998201981142029',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1691.1600928934.357456',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_056',
        patientId: 'HCC_056',
        ctSeriesUuid: 'f64e35bf-2c4d-4ff1-9fa9-0d1f5a1567e3',
        segSeriesUuid: 'd1bb3723-791a-42a9-aa2f-b509deabd3af',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.517812674630703228469833027469',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1709.1600928940.903778',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_057',
        patientId: 'HCC_057',
        ctSeriesUuid: '4e28ec15-fdbe-4974-bee5-41d96185df99',
        segSeriesUuid: 'b97c6198-708e-470a-8dd9-5b6da38976e6',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.285277799205131460288931056481',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1727.1600928946.640740',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER  2PHASE WITH CON · acq 2',
      },
      {
        caseId: 'HCC_058',
        patientId: 'HCC_058',
        ctSeriesUuid: 'f7032581-396f-411f-a141-aa4ca9ff5faa',
        segSeriesUuid: 'b2736368-baf7-4108-9298-0b53db96648b',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.114708972120578073459701447733',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1745.1600928952.343329',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 3 PHASE (AP) · acq 2',
      },
      {
        caseId: 'HCC_059',
        patientId: 'HCC_059',
        ctSeriesUuid: '70940fc1-19ac-4a9d-bf88-c668fdfb0280',
        segSeriesUuid: '868db58f-27b2-4eac-9b31-c38f5f7bb982',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.217246477731609919540600644613',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1763.1600928958.932669',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_060',
        patientId: 'HCC_060',
        ctSeriesUuid: '778fd221-8318-45c0-8cc9-cbc76e7039f7',
        segSeriesUuid: '4ca44ec3-c198-4d73-824f-817f0809355c',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.326314184617946193711420011727',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1781.1600928965.244794',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_061',
        patientId: 'HCC_061',
        ctSeriesUuid: 'f769bed4-c8d0-4b5c-ac45-99d4fc530add',
        segSeriesUuid: 'b1e9ca4c-1051-4283-916f-57840e9cc6c4',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.252224761611421202877051519494',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1799.1600928973.209529',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_062',
        patientId: 'HCC_062',
        ctSeriesUuid: '28eadad6-e90e-40d8-b668-e4a141970daa',
        segSeriesUuid: 'b85aa1d3-300a-4204-8dff-4ebb14d2a0a7',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.250973558206685478828810431730',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1817.1600928980.525144',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_063',
        patientId: 'HCC_063',
        ctSeriesUuid: 'c0b4219c-5c77-4cce-b9fd-5de6123f04bf',
        segSeriesUuid: '2cd5fd72-f57b-485f-a191-7a399644c427',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.125226904930109418407714368092',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1835.1600928987.421286',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_064',
        patientId: 'HCC_064',
        ctSeriesUuid: '8c373a0d-a062-41b0-9cce-563c172b7dd2',
        segSeriesUuid: 'c7589528-28f0-424a-bbcf-1dfc47d58408',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.290751000748704335669604888140',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1853.1600928994.936957',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_065',
        patientId: 'HCC_065',
        ctSeriesUuid: 'caa97cdf-277c-4725-b78d-5c32efac79f5',
        segSeriesUuid: '534c5d49-317f-40f9-bf18-a40d7b008269',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.442591155369734729751111676106',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1871.1600929002.972172',
        description: 'VENOUS',
      },
      {
        caseId: 'HCC_066',
        patientId: 'HCC_066',
        ctSeriesUuid: '047ea1be-0111-4c7e-9260-b4cce5150148',
        segSeriesUuid: '07e40b7e-d745-4e46-81c5-a12eef5fcb26',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.227222861794049267381351168998',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1889.1600929010.356739',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_067',
        patientId: 'HCC_067',
        ctSeriesUuid: '4bebe98d-659d-4229-a1f3-e1cd2f4125ae',
        segSeriesUuid: '14151dc7-c880-4c55-96f4-c32bfc8c9a98',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.180067852414349301867551039148',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1907.1600929016.25994',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_069',
        patientId: 'HCC_069',
        ctSeriesUuid: '89510641-b629-49fa-a7c1-8b15f1e0eb1a',
        segSeriesUuid: '15e47056-4844-4ec5-82fa-5990c35ccf64',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.118573920730464616796050822574',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1943.1600929034.853306',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_070',
        patientId: 'HCC_070',
        ctSeriesUuid: 'b1ea344f-1e42-4ce9-9869-30316b1ae720',
        segSeriesUuid: '52ebaa1a-f450-4dec-a721-faeee11f6151',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.136142978609094228680670121332',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1961.1600929040.245395',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_071',
        patientId: 'HCC_071',
        ctSeriesUuid: 'd49f8713-5643-4546-b03e-983832a398f9',
        segSeriesUuid: 'b8c929e9-ed81-4aba-91bc-e1f07cce46f2',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.265323445236226961557278014824',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1979.1600929048.433089',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_072',
        patientId: 'HCC_072',
        ctSeriesUuid: 'b9cb79e9-a188-45f9-9826-aae952783665',
        segSeriesUuid: 'a2904746-e5c7-4d1b-86e5-9606e6d9bd0c',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.607346132854433511832767843336',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.1997.1600929053.629319',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_073',
        patientId: 'HCC_073',
        ctSeriesUuid: '687895ac-1d28-4780-a2ba-119fffdbba3c',
        segSeriesUuid: '4145c73b-57c4-4082-a9df-e097008a8334',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.248128077663297154202444477856',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2015.1600929060.445346',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_074',
        patientId: 'HCC_074',
        ctSeriesUuid: 'd6a7db6b-c74d-4c0b-b574-a068db715d99',
        segSeriesUuid: 'db690201-0960-4efc-865e-6280f9019593',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.113594412243011178876032394722',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2033.1600929071.729584',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_075',
        patientId: 'HCC_075',
        ctSeriesUuid: '0159c5b0-89d6-4a24-9356-2d02663c775f',
        segSeriesUuid: 'bae1603f-d00b-4915-8f08-6ac70a2dddc6',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.325426780136243447362188862815',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2051.1600929079.527704',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_076',
        patientId: 'HCC_076',
        ctSeriesUuid: 'fc548e49-c02f-45c6-a9a6-e74bd671c5e6',
        segSeriesUuid: '29a303aa-3c3a-43f6-a467-e6dc3f506477',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.166934620093576998891755810342',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2069.1600929085.588188',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_077',
        patientId: 'HCC_077',
        ctSeriesUuid: '69610bf5-e18a-4086-851d-ca909a388c6e',
        segSeriesUuid: '45ffed4d-746c-4aab-b7d7-baf848309dce',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.231513034103627633230071228105',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2087.1600929091.391108',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_078',
        patientId: 'HCC_078',
        ctSeriesUuid: '01de028b-7655-4be4-a479-a5ff3227980d',
        segSeriesUuid: 'd1c67a82-c95a-4cc2-8123-7cb69dec787b',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.653090441871540850991978072647',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2105.1600929096.587537',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_079',
        patientId: 'HCC_079',
        ctSeriesUuid: 'edf0f95a-102c-4ff6-9c44-e302ddbead67',
        segSeriesUuid: 'c3a93320-ea97-4742-8acc-303e4ce2f98a',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.296618229708915362769101111139',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2123.1600929101.574021',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_080',
        patientId: 'HCC_080',
        ctSeriesUuid: 'a9ce5f6f-2c6a-42f1-b961-4eb26c66a735',
        segSeriesUuid: 'a826f946-1be3-42ce-ac08-a40d924df975',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.185913124054367140512236085438',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2141.1600929108.363935',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_081',
        patientId: 'HCC_081',
        ctSeriesUuid: '9ff62014-f33c-4b93-ac80-abebe5cfb808',
        segSeriesUuid: '182fb18a-fb89-4bd7-ab1d-f144a4a4a298',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.328381013969207951913699003250',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2159.1600929114.382937',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_083',
        patientId: 'HCC_083',
        ctSeriesUuid: 'bdcf8370-197e-4e05-8a14-41e86ec7ad40',
        segSeriesUuid: '27640b61-4125-41b3-bdd4-07a0e848f2ac',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.750563510899566959505493273659',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2195.1600929131.632049',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_084',
        patientId: 'HCC_084',
        ctSeriesUuid: 'f75713cc-06a9-4690-be62-1f06f7240c13',
        segSeriesUuid: '6e5cab46-7482-4b94-b081-76a76e7110e7',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.191324202061345602148411436922',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2213.1600929137.174513',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_086',
        patientId: 'HCC_086',
        ctSeriesUuid: '8b97a20c-e623-4943-af47-9affc8c02e87',
        segSeriesUuid: '9cf5e20d-78e3-4b1c-a81c-5ca80b643d0e',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.193237356615179430053410935086',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2249.1600929152.997980',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_087',
        patientId: 'HCC_087',
        ctSeriesUuid: 'c2d9fc4a-d0d0-4fe5-aa37-faf70a3e0cb5',
        segSeriesUuid: 'ef43d3f7-f843-4f21-b3b0-2ad2f9be136f',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.175102370673309142421460543427',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2267.1600929158.188592',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_088',
        patientId: 'HCC_088',
        ctSeriesUuid: '9bb08b01-73aa-4297-8f55-2ba4d016d580',
        segSeriesUuid: '490f2770-d37c-40e1-9dbf-a46032961f3d',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.311559970363125384212318993167',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2285.1600929163.332733',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_090',
        patientId: 'HCC_090',
        ctSeriesUuid: 'caa03bf2-ae97-44b9-ab51-e2f52d30aa22',
        segSeriesUuid: '7dccb6dc-ad12-4b1b-b8a4-e69097c303d0',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.103290589086124758282960561281',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2321.1600929175.145722',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2 PHASE (C/A/P) · acq 2',
      },
      {
        caseId: 'HCC_093',
        patientId: 'HCC_093',
        ctSeriesUuid: '557a6ff1-68b2-4b26-b492-7d9a906d2873',
        segSeriesUuid: '01445768-c621-4511-aa9d-0adf362ff1ad',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.102236702835548398521518585145',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2375.1600929210.230376',
        acquisitionNumber: 2,
        description: '2.5 STANDARD · acq 2',
      },
      {
        caseId: 'HCC_096',
        patientId: 'HCC_096',
        ctSeriesUuid: '5b70690a-8019-4ba2-9150-3a35aad93891',
        segSeriesUuid: 'f4f2bbc1-2945-42e0-a450-29fd6f69260d',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.285148415629932506365664022608',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2429.1600929242.460883',
        acquisitionNumber: 2,
        description: '2.5 STANDARD · acq 2',
      },
      {
        caseId: 'HCC_098',
        patientId: 'HCC_098',
        ctSeriesUuid: '766958f6-be83-430f-bce9-3d7c3afed6d9',
        segSeriesUuid: 'a2e4331c-80c6-4add-8761-8aa46b86ea93',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.251674316328407730350178816293',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2465.1600929258.417555',
        acquisitionNumber: 2,
        description: 'Recon 3: LIVER 2PHASE CAP · acq 2',
      },
      {
        caseId: 'HCC_100',
        patientId: 'HCC_100',
        ctSeriesUuid: '74dbe10b-d69e-4410-ae78-555125e97283',
        segSeriesUuid: 'a6e6ebe5-c93b-4649-aaf7-5ef48dcca33a',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.377621873196736214340157083210',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2501.1600929283.818744',
        acquisitionNumber: 2,
        description: '2.5 STANDARD · acq 2',
      },
      {
        caseId: 'HCC_104',
        patientId: 'HCC_104',
        ctSeriesUuid: 'a08f5fba-47d3-4da6-a4b2-f131dcb9c96d',
        segSeriesUuid: '0edc0062-3e99-4e53-9270-4441433a2713',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.768306713771639916590575469617',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2573.1600929325.962477',
        acquisitionNumber: 2,
        description: '2.5 STANDARD · acq 2',
      },
      {
        caseId: 'HCC_105',
        patientId: 'HCC_105',
        ctSeriesUuid: '8a2d219c-78db-418d-b049-a897deee407e',
        segSeriesUuid: '2dfd3310-7e77-4542-ab9e-50ee3d791748',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.1706.8374.332424215968991956405444812674',
        segSeriesInstanceUid: '1.2.276.0.7230010.3.1.3.8323329.2591.1600929335.372224',
        acquisitionNumber: 2,
        description: '2.5 STANDARD · acq 2',
      },
      ],
    },
    description:
      'Multiphase contrast CT of 105 HCC patients before TACE (MD Anderson) with curated liver, ' +
      'tumour and vessel DICOM-SEG. External test set: not in the stated training data of any ' +
      'catalogue model. Pulled directly from TCIA via the NCI Imaging Data Commons public bucket.',
    methodsNote:
      'HCC-TACE-Seg: CT series hold 1–3 contrast phases at identical slice positions and the DICOM-SEG ' +
      'references instances from more than one; the acquisition that fully contains the SEG and is the most ' +
      'venous available (max portal-vein minus aorta HU in the SEG vessel segments) is used, assuming negligible ' +
      'inter-phase motion. The aorta is still brighter than the portal vein in most cases (late-arterial / early ' +
      'portal inflow), so the phase is reported per case rather than labelled portal-venous. Reference whole liver = SEG "Liver" ∪ "Mass"; tumour = "Mass"; vessel segments ' +
      'are excluded, so intrahepatic vessels can appear as holes in the reference liver (see the hole-filled ' +
      'sensitivity analysis). Cases: all 82 of 105 patients passing the pre-specified QC (single annotated grid, a ' +
      'non-arterial acquisition, SEG fully inside the CT; flow log scripts/bench/data/hcc_flow.csv). Licence CC BY 4.0.',
  },
  {
    id: 'crlm',
    name: 'Colorectal-Liver-Metastases (TCIA, MSKCC)',
    modality: 'CT',
    subjects: 197,
    license: 'CC-BY-4.0',
    doi: '10.7937/QXK2-QG03',
    pageUrl: 'https://www.cancerimagingarchive.net/collection/colorectal-liver-metastases/',
    citation:
      'Simpson AL, Peoples J, Creasy JM, et al. Preoperative CT and survival data for patients undergoing ' +
      'resection of colorectal liver metastases. Sci Data 11, 172 (2024). doi:10.1038/s41597-024-02981-2. ' +
      'Data: Colorectal-Liver-Metastases, The Cancer Imaging Archive, doi:10.7937/QXK2-QG03',
    groundTruth: ['liver', 'tumor', 'hepatic veins', 'portal vein', 'future liver remnant'],
    gtLabels: { liver: [1], tumour: [2] },
    access: {
      kind: 'idc-s3',
      collectionId: 'colorectal_liver_metastases',
      // Pre-specified subset: the first 50 PatientIDs (ascending) that pass the QC of
      // scripts/bench/data/fetch_crlm.py (flow log: scripts/bench/data/crlm_flow.csv): CRLM-CT-1001…1060,
      // 9 of those 59 patients excluded for 7.5 mm slices. One portal-venous acquisition per series, so no
      // acquisitionNumber is pinned. Expert SEG only (IDC's AIMI AI SEGs are not used).
      cases: [
      {
        caseId: 'CRLM-CT-1001',
        patientId: 'CRLM-CT-1001',
        ctSeriesUuid: '7e1b9aa1-be25-41ee-b40f-8ffa8e39bb03',
        segSeriesUuid: '394ba867-3584-45df-8b9e-90bff18f436a',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.533669585389327696272831671548',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.370971589400256299984427146600',
        description: '161 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1002',
        patientId: 'CRLM-CT-1002',
        ctSeriesUuid: 'cfe8bfbd-fc51-45ba-a62a-b556ebf3d270',
        segSeriesUuid: 'b9c641cc-e9e2-49d3-a5ab-55f1a21803d6',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.455038217313067138673184936282',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.302964673037904770968458531097',
        description: '178 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1003',
        patientId: 'CRLM-CT-1003',
        ctSeriesUuid: '1f63d54b-38a1-4c8b-9975-0012aba80e57',
        segSeriesUuid: 'c69f8902-bcfa-4c27-84ab-34d3572832b0',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.998520027522620198855715156108',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.233692783386264068613732019177',
        description: '51 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1004',
        patientId: 'CRLM-CT-1004',
        ctSeriesUuid: 'a192c6ca-69b0-4195-bfa5-4fe9962b2da6',
        segSeriesUuid: '66d4fafb-bb3f-4b25-92b4-08a35d9ca4e9',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.254242588659825836950462054011',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.703131922535045894161106211647',
        description: 'CT CH/AB/PEL · 41 × 5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1005',
        patientId: 'CRLM-CT-1005',
        ctSeriesUuid: '78c920c6-2047-477c-a141-26d3be32c8a5',
        segSeriesUuid: '6c234f24-7326-4e1a-b059-dd19f55857ce',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.337637593354161532552899758706',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.118955862549854116020933638195',
        description: '141 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1006',
        patientId: 'CRLM-CT-1006',
        ctSeriesUuid: '379cdaec-5a2b-47c2-ad49-ab0a3f60c72d',
        segSeriesUuid: '50944f6f-33ee-4808-848a-dc3eea6bfe7e',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.286130801613533577338339572281',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.756355460888423922858731184978',
        description: '51 × 5 mm · 8 tumours',
      },
      {
        caseId: 'CRLM-CT-1007',
        patientId: 'CRLM-CT-1007',
        ctSeriesUuid: '87e8e675-51b7-452f-8872-b0a0ef0b11bd',
        segSeriesUuid: 'a1c877a5-8065-42c7-a93c-bbc3dc333227',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.647078994044139971307880938775',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.943061260212119869273525493329',
        description: 'CT CH/AB/PEL · 51 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1008',
        patientId: 'CRLM-CT-1008',
        ctSeriesUuid: 'd9089940-6fea-4e3a-9470-4cf6a59d2800',
        segSeriesUuid: 'c6f57f00-a9e8-418f-8fe8-5b880d89ae10',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.147176332383727661808052737381',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.857191344749379360552192917136',
        description: 'Bind(17095/4/277..465) · 148 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1009',
        patientId: 'CRLM-CT-1009',
        ctSeriesUuid: '5658da22-3d56-4286-8412-ae3775cf7dd8',
        segSeriesUuid: '5c6e55ea-097a-4855-968f-1f24560eb7e4',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.687291219842059178499568815022',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.143726154799411709472080461674',
        description: '141 × 1.5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1010',
        patientId: 'CRLM-CT-1010',
        ctSeriesUuid: '895a123d-da2b-490e-9e4b-55d300bcc892',
        segSeriesUuid: '56ba5402-6568-4862-b0fc-485ef5b2fb32',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.270035007174709027864394981424',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.173693292793710176384410782358',
        description: '47 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1011',
        patientId: 'CRLM-CT-1011',
        ctSeriesUuid: '0fa05b0e-8729-499f-b887-3bc321deb1b7',
        segSeriesUuid: '06598137-a663-4261-8c0b-c09476527115',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.309953836542238933910820230787',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.752172368918633153558389544498',
        description: 'CT CH/AB/PEL · 36 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1012',
        patientId: 'CRLM-CT-1012',
        ctSeriesUuid: '2b4432c8-9b71-4b1d-bdb3-4b9bf6509e7e',
        segSeriesUuid: 'ffe070d3-5303-441c-a62d-90889f21236d',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.301632122009735814844594931449',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.127843976779466573147531065567',
        description: '158 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1013',
        patientId: 'CRLM-CT-1013',
        ctSeriesUuid: '289dca37-07ef-4c14-ace5-896dacf56962',
        segSeriesUuid: '2fb4dac2-2026-4b34-a1ff-436ed4b2cd53',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.100952006031871945347699469921',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.173669580727309707174429812418',
        description: '131 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1014',
        patientId: 'CRLM-CT-1014',
        ctSeriesUuid: '2391a044-4adb-40e6-92a3-d2da0781c53f',
        segSeriesUuid: '5778c922-86e3-44e1-a77a-dcadc1897ea1',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.310919066612974268195709015368',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.440803058654740867148486811122',
        description: '55 × 5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1015',
        patientId: 'CRLM-CT-1015',
        ctSeriesUuid: '5747c6ed-5d27-4efa-8d9c-532301720f0c',
        segSeriesUuid: '8870993e-96a2-4175-b281-4d85b3f0f97f',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.239803565971926420748072311730',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.901531966952169050765398439181',
        description: '48 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1017',
        patientId: 'CRLM-CT-1017',
        ctSeriesUuid: '80a88567-44bf-4768-89ae-7566929939c0',
        segSeriesUuid: '941bac46-a932-4066-a9d8-5267f3adbf56',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.207339518727715932140231193509',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.227108728841008237605612405298',
        description: '117 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1018',
        patientId: 'CRLM-CT-1018',
        ctSeriesUuid: 'df37209a-3a59-4c17-aa69-55b3ae0d3b81',
        segSeriesUuid: '81cd9a1b-5676-48b9-82dc-c0106b4a480d',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.188875005497186250413797336559',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.123479285754797890598337890865',
        description: '83 × 2.5 mm · 3 tumours',
      },
      {
        caseId: 'CRLM-CT-1019',
        patientId: 'CRLM-CT-1019',
        ctSeriesUuid: '2dda543a-61af-4bee-b1c3-8351c2d0281c',
        segSeriesUuid: '47fe43b3-af61-46b8-baa6-9fcc628c0f06',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.964317152217057892134610035026',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.197802176659053188716414492299',
        description: '145 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1023',
        patientId: 'CRLM-CT-1023',
        ctSeriesUuid: '12551387-c812-444e-8429-dc4e2ab32ff9',
        segSeriesUuid: '5d7505d6-fa3c-4bd9-bab1-79c0866a6792',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.418402510763139732273882958170',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.583696965671483485004126852516',
        description: '40 × 5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1025',
        patientId: 'CRLM-CT-1025',
        ctSeriesUuid: '50835127-ab9d-430c-8002-6d5f69c375c9',
        segSeriesUuid: 'ce9fb1ee-80c4-4b90-b992-3a892139c5a4',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.335331127504900561062356850777',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.212891889449071524659475966235',
        description: '164 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1026',
        patientId: 'CRLM-CT-1026',
        ctSeriesUuid: '1295c825-cd3d-4d9e-b4eb-3496dc07f043',
        segSeriesUuid: 'a999468b-a698-42c0-bb07-d22a20e3df5f',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.275179554444442893192427753220',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.289166167875029799350800214977',
        description: 'Bind(2895/4/246..509) · 183 × 1.5 mm · 5 tumours',
      },
      {
        caseId: 'CRLM-CT-1028',
        patientId: 'CRLM-CT-1028',
        ctSeriesUuid: '4e990aec-00c0-49e3-90bf-58adcc692897',
        segSeriesUuid: 'f4bbe027-f5d6-4709-a8eb-b6e9a99ede67',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.272763484330811506189966364629',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.198968923379665142689540530251',
        description: 'CT CAP W/CONTRAST · 45 × 5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1029',
        patientId: 'CRLM-CT-1029',
        ctSeriesUuid: '6a1c1691-4085-47f0-b156-9a05c6764d68',
        segSeriesUuid: '99ec2274-0fd9-4173-8c20-1ecba4fd76cc',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.282170518409954668983659542131',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.851244890409717685022349918368',
        description: '143 × 1.5 mm · 3 tumours',
      },
      {
        caseId: 'CRLM-CT-1030',
        patientId: 'CRLM-CT-1030',
        ctSeriesUuid: '15fc0810-a2e2-4b32-8c3c-217ebc92ba32',
        segSeriesUuid: '3e195ff0-9c03-45c2-9451-5adddc35ba85',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.277340911308471898169920567877',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.134398856232941974205966407470',
        description: 'Bind(18383/5/190..403) · 118 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1031',
        patientId: 'CRLM-CT-1031',
        ctSeriesUuid: '47c8412a-d085-4101-80f4-f1be66856c84',
        segSeriesUuid: 'c1b6c277-d73e-4197-a1a3-1b6b02e102ab',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.998338835348542251361411222040',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.265629450175310470010202247243',
        description: 'CT CH/AB/PEL · 44 × 5 mm · 3 tumours',
      },
      {
        caseId: 'CRLM-CT-1032',
        patientId: 'CRLM-CT-1032',
        ctSeriesUuid: 'cc5e828f-f3df-4fec-9170-c4fc0c3da08f',
        segSeriesUuid: '230590e2-edfb-4dcd-9593-1e5b595157d1',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.581986813711373802602074144049',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.270725990320922786952565568716',
        description: '168 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1033',
        patientId: 'CRLM-CT-1033',
        ctSeriesUuid: '5b340dac-e939-4e58-963b-b78691352a01',
        segSeriesUuid: '9dfa461b-66fb-48c7-a873-5f022fbf1ac0',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.188301572587551944700194687822',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.236221364888927043393959994144',
        description: '54 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1034',
        patientId: 'CRLM-CT-1034',
        ctSeriesUuid: '75c7167d-2806-4e45-b6ae-efa0c70f5573',
        segSeriesUuid: '0df06a32-36c0-4b11-a0b4-40216bb95c2c',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.172756199396350563913348887782',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.863299430606407689073605341266',
        description: 'CT CH/AB/PEL · 41 × 5 mm · 7 tumours',
      },
      {
        caseId: 'CRLM-CT-1035',
        patientId: 'CRLM-CT-1035',
        ctSeriesUuid: 'fe1986f9-2d33-493f-853e-09bf05202f34',
        segSeriesUuid: '073a68ba-baad-4079-be28-eb02c40ee84d',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.193833111196743252174568266242',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.921324811530230368109722049306',
        description: 'POST CON · 48 × 5 mm · 4 tumours',
      },
      {
        caseId: 'CRLM-CT-1037',
        patientId: 'CRLM-CT-1037',
        ctSeriesUuid: 'ef5be09a-40c3-4768-8b7b-ff85b5b6f650',
        segSeriesUuid: '65a2e1e7-21c0-4866-bfdb-0759efdc55a2',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.125471439770422271237569071290',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.120877117892925961003430775776',
        description: '144 × 1.5 mm · 5 tumours',
      },
      {
        caseId: 'CRLM-CT-1038',
        patientId: 'CRLM-CT-1038',
        ctSeriesUuid: 'c776e6d9-d64c-4138-a991-242ba30f3fa5',
        segSeriesUuid: 'bf01222c-276d-4876-9b77-9cb52e065da3',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.332172094997506313675345545370',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.171629450462112986617480664756',
        description: 'CT CH/AB/PEL · 38 × 5 mm · 3 tumours',
      },
      {
        caseId: 'CRLM-CT-1039',
        patientId: 'CRLM-CT-1039',
        ctSeriesUuid: '02113911-d18c-4f74-a8a2-3a7a2135732c',
        segSeriesUuid: 'a902b6e1-35a9-4d70-ade1-07b09abf1ca7',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.285057027785818642471856167397',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.219195651091192636662269601791',
        description: 'POST CON · 46 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1041',
        patientId: 'CRLM-CT-1041',
        ctSeriesUuid: 'afdc19f0-435c-4c4a-aa07-b8ae47e0e048',
        segSeriesUuid: '67a7068d-a0c4-4cb2-b372-6cb18274c151',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.954095440657642475078953332364',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.194997843904437717268925843684',
        description: 'Chest/Abdomen/Pelvis · 35 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1042',
        patientId: 'CRLM-CT-1042',
        ctSeriesUuid: '30499731-7baf-4cf2-a642-10828bb418e4',
        segSeriesUuid: '9818bc4e-44d7-49cb-a911-75c3d0672e71',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.314246100726023064824453698708',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.235083009823851577659753403667',
        description: '148 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1043',
        patientId: 'CRLM-CT-1043',
        ctSeriesUuid: '59a2f999-6694-40f6-996e-bc2e381e543e',
        segSeriesUuid: '0f92c1a4-9a32-4f30-9bae-d3a1555d5e8b',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.764582342349300234807400030822',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.163975835922834777568034818274',
        description: '121 × 1.5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1045',
        patientId: 'CRLM-CT-1045',
        ctSeriesUuid: '3b5daed1-5a1b-4f7b-ba1c-4a029eb1bc9f',
        segSeriesUuid: 'c0655310-651d-423b-a2a8-28362fdf2d9f',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.308147810576192288411205914285',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.490945266728191448474015089678',
        description: '141 × 1.5 mm · 3 tumours',
      },
      {
        caseId: 'CRLM-CT-1046',
        patientId: 'CRLM-CT-1046',
        ctSeriesUuid: '1a87f9b4-7c9b-4e3f-a444-5e6c7843695d',
        segSeriesUuid: 'b9d65142-4dac-409b-b775-30c2dfc389fa',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.876266207167921740530708709916',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.198419865300741306933067795121',
        description: 'CT CH/AB/PEL · 47 × 5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1047',
        patientId: 'CRLM-CT-1047',
        ctSeriesUuid: 'aa972b59-4435-4594-b141-9ec45ba6e844',
        segSeriesUuid: 'af0c6535-660d-4277-8aad-40798ff98a7c',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.313792416985945660273944040360',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.311855723064893953342617805967',
        description: '45 × 5 mm · 3 tumours',
      },
      {
        caseId: 'CRLM-CT-1048',
        patientId: 'CRLM-CT-1048',
        ctSeriesUuid: 'ef4317d6-c35c-4355-92a3-f43f1900f364',
        segSeriesUuid: 'f8e50ae6-be62-4859-9182-f1170dcac49c',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.295752131880409282102303653837',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.139197822888178710253680689386',
        description: '46 × 5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1049',
        patientId: 'CRLM-CT-1049',
        ctSeriesUuid: 'a7f99aee-ee6a-4a1b-b0db-8d8424ca352a',
        segSeriesUuid: '97598b1a-7cae-4d85-9dee-1906e3e681f8',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.265256104276095000640066677784',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.291689483221201516194032867002',
        description: 'Bind(2461/5/277..520) · 128 × 1.5 mm · 4 tumours',
      },
      {
        caseId: 'CRLM-CT-1050',
        patientId: 'CRLM-CT-1050',
        ctSeriesUuid: 'db8a5bbe-3af3-4696-8165-9e97d2eed00c',
        segSeriesUuid: 'f0c56928-e438-453c-a319-c602fe7954f2',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.241683445123776287407186888673',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.239530865933937439121799908024',
        description: '139 × 1.5 mm · 3 tumours',
      },
      {
        caseId: 'CRLM-CT-1051',
        patientId: 'CRLM-CT-1051',
        ctSeriesUuid: '0806289a-cd8e-4675-9b93-161a7a305fe8',
        segSeriesUuid: '22a2a594-37c9-4008-9765-dd20631eb627',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.261181999170280359234642293629',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.588029137173005554947850610199',
        description: '162 × 1.5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1052',
        patientId: 'CRLM-CT-1052',
        ctSeriesUuid: 'cf6a9249-eb96-43cf-9675-29a5c4b65e6b',
        segSeriesUuid: 'e36f10f3-6872-4eca-82b0-6efb8e6bea54',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.316224318528459980880332165110',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.124461738198954396242727988280',
        description: '58 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1053',
        patientId: 'CRLM-CT-1053',
        ctSeriesUuid: '0a02b8ed-b7d0-47aa-af59-336664a6c89c',
        segSeriesUuid: '4ed62430-2d86-4fc0-a1c9-d671d98c23c5',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.116565820947214889691718052511',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.258785159308886896659782944334',
        description: '134 × 1.5 mm · 3 tumours',
      },
      {
        caseId: 'CRLM-CT-1054',
        patientId: 'CRLM-CT-1054',
        ctSeriesUuid: '0839cca6-e84c-4e66-87a8-7deeb6f88b96',
        segSeriesUuid: 'af49ab02-44da-46ff-87d8-d812bfa79ed1',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.282379966485480280674271538733',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.351498730541372901741241411951',
        description: 'CT CH/AB/PEL · 46 × 5 mm · 2 tumours',
      },
      {
        caseId: 'CRLM-CT-1055',
        patientId: 'CRLM-CT-1055',
        ctSeriesUuid: '852d473a-9405-43e4-b285-063fe2742202',
        segSeriesUuid: 'f700c879-4b85-464c-a043-dc1e9cc25213',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.249852099227145528693507302696',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.287315216384721263749587362454',
        description: 'Bind(2451/4/171..390) · 121 × 1.5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1056',
        patientId: 'CRLM-CT-1056',
        ctSeriesUuid: 'd7677e6c-17e5-4138-9e0a-4f8bc7f95812',
        segSeriesUuid: 'f70eae8d-2f32-4c3a-8046-16eb57c2e981',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.245762170029847674795094257067',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.191276678086276854337138816111',
        description: '144 × 1.5 mm · 4 tumours',
      },
      {
        caseId: 'CRLM-CT-1057',
        patientId: 'CRLM-CT-1057',
        ctSeriesUuid: 'e4d48452-7642-429a-828a-fcaea405e7f1',
        segSeriesUuid: '0e3a1bef-ffe0-405a-9386-9aaa863a799e',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.179379764823583705640318646704',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.118510444734589874437400141517',
        description: '151 × 1.5 mm · 4 tumours',
      },
      {
        caseId: 'CRLM-CT-1058',
        patientId: 'CRLM-CT-1058',
        ctSeriesUuid: 'cbe8c245-95ae-4e9f-951b-8f5557375082',
        segSeriesUuid: 'da46c1f6-a801-454e-8fc7-5554659072af',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.113655809007607955375871244834',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.219350276936943435172465547704',
        description: 'CT CH/AB/PEL · 43 × 5 mm · 1 tumour',
      },
      {
        caseId: 'CRLM-CT-1060',
        patientId: 'CRLM-CT-1060',
        ctSeriesUuid: 'c050c8a0-804b-4cef-917d-3b70cff8f747',
        segSeriesUuid: '8a784951-1747-4be2-a77f-c5aa2c539cad',
        ctSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.103510359041289136780290400382',
        segSeriesInstanceUid: '1.3.6.1.4.1.14519.5.2.1.9203.8273.338128024247819616876552749248',
        description: 'CT ABDOMEN/PELVIS · 52 × 5 mm · 2 tumours',
      },
      ],
    },
    description:
      'Preoperative portal-venous contrast CT of 197 patients resected for colorectal liver metastases ' +
      '(Memorial Sloan Kettering Cancer Center) with expert DICOM-SEG of liver, tumours, hepatic and portal ' +
      'veins and future liver remnant. External for all catalogue models: MSKCC is not among the LiTS ' +
      'contributing centres (LiTS/MSD Task03 train nnU-Net) and BTCV is Vanderbilt data. Metastases are ' +
      'hypo-attenuating and often small (median 7 ml per case in the 50-case subset), unlike HCC-TACE-Seg.',
    methodsNote:
      'Colorectal-Liver-Metastases (CRLM, TCIA, CC BY 4.0): one preoperative portal-venous CT per patient (phase per ' +
      'the collection description; not verifiable per case, no aorta segment). Expert DICOM-SEG segments: "Liver" ' +
      '(whole liver incl. tumours and intrahepatic vessels), "Liver Remnant" (planned future liver remnant, a sub-region ' +
      'of Liver), "Hepatic" and "Portal" (veins), "Tumor_1…k". Reference whole liver = Liver ∪ all Tumor_k; tumour = ' +
      '∪ Tumor_k; vessels and remnant are not used (vessels are not subtracted, so there are no vessel holes; the ' +
      'in-app loader also counts "Liver Remnant" as liver, which lies ≥ 99.8 % inside "Liver"). Pre-specified subset: ' +
      'first 50 PatientIDs passing QC (expert SEG referencing one axial acquisition, slices ≤ 5 mm, SEG frames on the ' +
      'CT lattice and ≥ 98 % inside it, liver 500–5000 ml, < 5 % of reference-liver voxels below −10 HU); flow log ' +
      'scripts/bench/data/crlm_flow.csv. Slice spacing 1.5–5 mm.',
  },
  {
    id: 'btcv',
    name: 'BTCV Multi-Atlas Labeling Beyond the Cranial Vault (abdomen)',
    modality: 'CT',
    subjects: 50,
    license: 'Synapse data-use terms (registration)',
    doi: '10.7303/syn3193805',
    pageUrl: 'https://www.synapse.org/Synapse:syn3193805',
    citation:
      'Landman B, Xu Z, Iglesias JE, Styner M, Langerak TR, Klein A. MICCAI Multi-Atlas Labeling Beyond the ' +
      'Cranial Vault — Workshop and Challenge (BTCV), 2015. doi:10.7303/syn3193805',
    groundTruth: [
      'spleen',
      'kidneys',
      'gallbladder',
      'esophagus',
      'liver',
      'stomach',
      'aorta',
      'inferior vena cava',
      'portal/splenic veins',
      'pancreas',
      'adrenal glands',
    ],
    access: {
      kind: 'download',
      url: 'https://www.synapse.org/Synapse:syn3193805',
      note: 'Training distribution of the LightningMedSeg3D checkpoints (in-distribution reference for them). Synapse account required; load the NIfTI image + label files locally.',
    },
    gtLabels: { liver: [6], tumour: [] },
    description:
      '30 training + 20 test portal-venous abdominal CTs with 13 organ labels (liver = 6, no tumour label). ' +
      'In-distribution for the nine LightningMedSeg3D checkpoints; external for nnU-Net.',
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
      note: 'Training data of the nnU-Net model (LiTS; scores are resubstitution); external for the BTCV-trained LightningMedSeg3D nets. 29 GB tar — extract a few cases locally and load the NIfTI files.',
    },
    description:
      'Portal-venous CT with liver + tumour labels (LiTS). The labelled cases (imagesTr) are LiTS ' +
      'training cases, i.e. training data of the nnU-Net model (resubstitution, optimistic); external for ' +
      'the BTCV-trained LightningMedSeg3D nets.',
    methodsNote:
      'MSD Task03 Liver: labelled cases come from imagesTr (LiTS training set; CC BY-SA 4.0, share-alike applies ' +
      'to derived masks). Reference whole liver = label 1 ∪ 2, tumour = label 2. Slice thickness 0.7–5 mm.',
  },
];

/** Datasets every catalogue model can be tested on (external for all: TCIA liver collections with CT + SEG). */
const EXTERNAL_TEST_SETS = new Set(['hcc-tace-seg', 'crlm']);

export function datasetsForModel(model: CatalogModel): CatalogDataset[] {
  // Every model is paired with the external TCIA test sets plus its training sets.
  return CATALOG_DATASETS.filter((d) => EXTERNAL_TEST_SETS.has(d.id) || model.trainedOn.includes(d.id));
}

export function modelsForDataset(dataset: CatalogDataset): CatalogModel[] {
  if (EXTERNAL_TEST_SETS.has(dataset.id)) return [...CATALOG_MODELS];
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
  /** Zenodo provenance of the converted checkpoint. */
  zenodoRecord?: string;
  sourceFile?: string;
  sourceMd5?: string;
  sourceSha256?: string;
}

export interface ModelIndex {
  release: string;
  models: ModelIndexEntry[];
  /** CORS-friendly mirror bases (Hugging Face only), preferred over the release. */
  mirrors: string[];
}

// Pinned to the active mirror repo (this user's choice or the build default): the index may
// choose the revision, never the owner.
export function isValidMirror(base: unknown, owner: string = activeMirrorOwner()): base is string {
  if (typeof base !== 'string') return false;
  const prefix = `https://huggingface.co/${owner}/tamias-zenodo-liver-models/resolve/`;
  return base.startsWith(prefix) && /^[A-Za-z0-9._-]+$/.test(base.slice(prefix.length));
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
    if (m.sourceMd5 !== undefined && m.sourceMd5 !== null && (typeof m.sourceMd5 !== 'string' || !/^[0-9a-f]{32}$/i.test(m.sourceMd5))) {
      throw new Error(`Model index: ${m.id}.sourceMd5 must be 32 hex chars.`);
    }
    if (
      m.sourceSha256 !== undefined &&
      m.sourceSha256 !== null &&
      (typeof m.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sourceSha256))
    ) {
      throw new Error(`Model index: ${m.id}.sourceSha256 must be 64 hex chars.`);
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
      zenodoRecord: typeof m.zenodoRecord === 'string' && /^\d+$/.test(m.zenodoRecord) ? m.zenodoRecord : undefined,
      sourceFile: typeof m.sourceFile === 'string' ? m.sourceFile : undefined,
      sourceMd5: typeof m.sourceMd5 === 'string' ? m.sourceMd5.toLowerCase() : undefined,
      sourceSha256: typeof m.sourceSha256 === 'string' ? m.sourceSha256.toLowerCase() : undefined,
    };
  });
  const mirrors = Array.isArray(raw.mirrors) ? raw.mirrors.filter((m: unknown) => isValidMirror(m)) : [];
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
      sourceMd5: e.sourceMd5 ?? m.sourceMd5,
      sourceSha256: e.sourceSha256 ?? m.sourceSha256,
      status: e.status,
      error: e.error ?? null,
    };
  });
}

/**
 * Catalogue entry behind a benchmark record's model: the record's catalogue id
 * when present (in-app runs), else the model family recognisable from the
 * published manifest name (headless / CI records; family-level provenance).
 */
export function catalogModelForRecord(model: { name: string; catalogId?: string }): CatalogModel | undefined {
  const byId = model.catalogId ? CATALOG_MODELS.find((m) => m.id === model.catalogId) : undefined;
  if (byId) return byId;
  if (/^LightningMedSeg3D\b/i.test(model.name)) return CATALOG_MODELS.find((m) => m.family === 'lightningmedseg3d');
  if (/^nnU-Net v2 Liver/i.test(model.name)) return CATALOG_MODELS.find((m) => m.family === 'nnunet');
  return undefined;
}

/** Catalogue datasets a benchmark record's model was trained on ([] if unknown). */
export function trainedOnForRecordModel(model: { name: string; catalogId?: string }): string[] {
  return catalogModelForRecord(model)?.trainedOn ?? [];
}
