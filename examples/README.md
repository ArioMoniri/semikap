# Sample data and models

TAMIAS ships no hand-built, synthetic or placeholder models and no
synthetic images. Everything the app offers for trying it out is real:

## In the app — Examples card

- **Benchmark kits** (default selection) — published nnU-Net /
  LightningMedSeg3D checkpoints from Zenodo, paired with public TCIA /
  Medical Segmentation Decathlon cases that carry expert reference
  segmentations. *Open kit* preselects everything in Catalogue → Batch
  benchmark; *Run* downloads, runs and scores every model × case pair.
  See [`docs/CATALOGUE.md`](../docs/CATALOGUE.md).
- **Sample scans** — real anonymised public scans from
  [niivue-demo-images](https://github.com/niivue/niivue-demo-images)
  (CC-BY-SA), fetched on demand and cached in the browser's private
  storage. Image only; pair them with a catalogue model, SAM or
  TotalSegmentator.

| Scan | What it is |
|---|---|
| `CT_AVM.nii.gz` | 463 KB head/neck CT angiography with an arteriovenous malformation |
| `CT_Abdo.nii.gz` | 7.75 MB abdominal CT (not portal-venous phase) |
| `mni152.nii.gz` | 4.3 MB MNI152 T1 brain template (average of real T1 acquisitions) |

## More public imaging data

| Source | What | License |
|---|---|---|
| [niivue-demo-images](https://github.com/niivue/niivue-demo-images) | 30+ small CT/MR/fMRI NIfTI files | CC-BY-SA |
| [Medical Segmentation Decathlon](http://medicaldecathlon.com/) | 10 organ/tumour segmentation tasks | CC-BY-SA |
| [TCIA](https://www.cancerimagingarchive.net/collections/) / [IDC](https://portal.imaging.datacommons.cancer.gov/) | De-identified DICOM collections (browse IDC in-app) | mostly CC-BY |
| [OpenNeuro](https://openneuro.org/) | Neuroimaging datasets (BIDS) | CC0 / PDDL |

## Real models

- The in-app **Catalogue** (Zenodo-hosted, parity-checked ONNX exports).
- [TotalSegmentator](https://github.com/wasserth/TotalSegmentator) — via
  the desktop native runner or an ONNX export (see
  [`docs/TOTALSEGMENTATOR.md`](../docs/TOTALSEGMENTATOR.md)).
- [MONAI Model Zoo](https://monai.io/model-zoo.html),
  [nnU-Net](https://github.com/MIC-DKFZ/nnUNet),
  [MedSAM](https://github.com/bowang-lab/MedSAM) — export to ONNX and
  load with a manifest; see
  [Bring your own model](../README.md#-bring-your-own-model).

Pathology: see [`pathology/README.md`](pathology/README.md).
