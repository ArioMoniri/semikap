/**
 * Ready-made benchmark kits (Examples panel → "Benchmark kits"): a dataset,
 * its cases and the Zenodo models to run on them. Opening a kit preselects
 * everything in Catalogue → Batch benchmark; the user presses Run.
 */
import { CATALOG_DATASETS, CATALOG_MODELS } from './catalog';

export interface BenchmarkKit {
  id: string;
  name: string;
  description: string;
  datasetId: string;
  /** Case ids (IDC datasets); omitted for local NIfTI datasets. */
  caseIds?: string[];
  modelIds: string[];
}

const hcc = CATALOG_DATASETS.find((d) => d.id === 'hcc-tace-seg')!;
const hccCases = hcc.access.kind === 'idc-s3' ? hcc.access.cases.map((c) => c.caseId) : [];
const allModels = CATALOG_MODELS.map((m) => m.id);
const lms3d = CATALOG_MODELS.filter((m) => m.family === 'lightningmedseg3d').map((m) => m.id);

export const BENCHMARK_KITS: readonly BenchmarkKit[] = [
  {
    id: 'hcc-quick',
    name: 'Quick start — 2 small models × 2 HCC-TACE-Seg cases',
    description:
      'SegFormer 3D (18 MB) and UNet++ (18 MB) on HCC_002 and HCC_003 — the whole flow (TCIA download, inference, scoring, statistics, mask comparison) in a few minutes.',
    datasetId: 'hcc-tace-seg',
    caseIds: hccCases.slice(0, 2),
    modelIds: ['lms3d_segformer', 'lms3d_unetpp'],
  },
  {
    id: 'hcc-cnn-vs-transformer',
    name: 'CNNs vs transformers — 9 LightningMedSeg3D nets × 5 HCC cases',
    description: 'All nine BTCV-trained architectures from Zenodo 21037952 on five external HCC-TACE-Seg cases.',
    datasetId: 'hcc-tace-seg',
    caseIds: hccCases.slice(0, 5),
    modelIds: lms3d,
  },
  {
    id: 'hcc-all-models',
    name: 'Full external benchmark — 10 Zenodo models × 10 HCC-TACE-Seg cases',
    description:
      'Every catalogue model (Zenodo 21037952 + 11582728) on all ten QC’d HCC-TACE-Seg cases, straight from TCIA. Long: nnU-Net takes minutes per case on CPU.',
    datasetId: 'hcc-tace-seg',
    caseIds: hccCases,
    modelIds: allModels,
  },
  {
    id: 'msd-local-all-models',
    name: 'Domain shift — 10 models × your MSD Task03 NIfTI cases',
    description:
      'Pick MSD Task03 Liver CT + label NIfTI files (label 1 liver, 2 tumour; in-distribution for nnU-Net, external for the BTCV nets) and compare with the HCC-TACE-Seg results.',
    datasetId: 'msd-task03-liver',
    modelIds: allModels,
  },
];
