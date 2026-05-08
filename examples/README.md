# 🧪 TAMIAS test kit

A self-contained 3-file bundle that lets you verify your TAMIAS install end-to-end without hunting for medical imaging data or ML models elsewhere. Total size: **~470 KB**.

| File | Size | What it is | Source |
|---|---|---|---|
| [`CT_AVM.nii.gz`](CT_AVM.nii.gz) | 463 KB | Compressed NIfTI of a small CT scan (head/neck arteriovenous malformation) | [niivue-demo-images](https://github.com/niivue/niivue-demo-images) — CC-BY-SA |
| [`threshold_seg.onnx`](threshold_seg.onnx) | 310 B | Trivial ONNX segmentation model: marks every voxel above the normalised midpoint as `bright_voxels` | Hand-built for this repo |
| [`threshold_seg.json`](threshold_seg.json) | 531 B | Manifest matching the ONNX model | Hand-written |

## What the model actually does

It's not a real medical AI — it's the simplest possible 3D segmentation graph that exercises every code path in TAMIAS:

```
Input:  voxels[1, 1, Z, Y, X]
Output: seg[1, 2, Z, Y, X]   where channel 0 = background, channel 1 = foreground
Logic:  fg_logit = voxels - 0.5    (after min-max normalisation to [0, 1])
        bg_logit = -fg_logit
        argmax → label 1 anywhere intensity exceeds the midpoint
```

So you get a clean "everything bright is the segmentation" result on the CT image. Useful for confirming:
- File loading works (DICOM/NIfTI/NRRD ingestion via NiiVue)
- Manifest parsing + SHA-256 verification
- Sliding-window inference (it's set to 64×64×64 patches, 25% overlap)
- Mask overlay rendering on the viewer
- WebGPU vs WASM-SIMD backend selection
- Mask export (NIfTI / DICOM-SEG)

## How to use

### Method A — From the running app

1. Open TAMIAS (web at your deploy URL, or the desktop app)
2. **Inputs** panel → **Browse** → pick `CT_AVM.nii.gz` from this folder
3. **Model** panel → **Load…** → pick `threshold_seg.onnx`, then `threshold_seg.json` when prompted
4. Click **Run inference**
5. Watch the green overlay appear on the viewer. **Save mask → .nii** to test the export path.

### Method B — From a fresh checkout

```sh
git clone https://github.com/ArioMoniri/semikap.git
cd semikap/examples
ls
```

The three files are right there — point the app at them.

### Method C — Curl-only (no clone)

```sh
mkdir -p ~/tamias-test && cd ~/tamias-test
BASE="https://raw.githubusercontent.com/ArioMoniri/semikap/main/examples"
curl -sLO "$BASE/CT_AVM.nii.gz"
curl -sLO "$BASE/threshold_seg.onnx"
curl -sLO "$BASE/threshold_seg.json"
ls -la
```

## Expected outcome

```
Inference complete in 2-15 s   ← depends on WebGPU vs WASM
via webgpu                     ← or webnn / wasm
```

Volumetrics row should look something like:
- `bright_voxels — N voxels — N mL`

Where N is roughly the number of CT voxels with HU > midpoint of the volume's intensity range. Visually it'll highlight bone + dense contrast in the CT.

## Going beyond the smoke test — more imaging data

If you want larger / more diverse images to play with, all of the below are free and public:

| Source | What | License | Size |
|---|---|---|---|
| **[niivue-demo-images](https://github.com/niivue/niivue-demo-images)** | 30+ small CT/MR/fMRI NIfTI files (the source of `CT_AVM.nii.gz`) | CC-BY-SA | ~80 MB total |
| **[Medical Decathlon](http://medicaldecathlon.com/)** | 10 organ-segmentation tasks (Spleen smallest, ~1.5 GB) | CC-BY-SA | 1.5–60 GB per task |
| **[TCIA — The Cancer Imaging Archive](https://www.cancerimagingarchive.net/collections/)** | Hundreds of de-identified DICOM collections | varies (mostly CC-BY) | varies |
| **[OpenNeuro](https://openneuro.org/)** | Neuroimaging datasets in BIDS format (NIfTI + JSON) | CC0 / PDDL | varies |
| **[Visible Human (NIH)](https://www.nlm.nih.gov/research/visible/visible_human.html)** | Whole-body cryosections + CT + MR | public domain | very large |
| **[3D Slicer sample data](https://www.slicer.org/wiki/SampleData)** | Brain MR, head CT, ultrasound, microscopy | varies | small |

For DICOM specifically, the smallest reliable source is **[3D Slicer's MR-head sample](https://github.com/Slicer/SlicerTestingData)** (~10 MB DICOM series).

## Going beyond the smoke test — real ONNX models

Swap the toy threshold model for a real medical AI:

- **[MONAI Model Zoo](https://monai.io/model-zoo.html)** — bundles for spleen, prostate, pancreas, liver, etc. Each can be exported to ONNX with the bundle's `convert_to_onnx.py` script.
- **[TotalSegmentator](https://github.com/wasserth/TotalSegmentator)** — 104-class whole-body organ segmentation. PyTorch by default; community ONNX exports exist on Hugging Face.
- **[MedSAM](https://github.com/bowang-lab/MedSAM)** — interactive medical Segment Anything. Has ONNX export instructions in their repo.
- **[SAM-Med2D](https://github.com/OpenGVLab/SAM-Med2D)** — 2D medical SAM with smaller weights.
- **[nnU-Net pre-trained models](https://github.com/MIC-DKFZ/nnUNet)** — DKFZ's task-specific models. Convert via `nnUNet_export_model_to_onnx`.
- **[Hugging Face](https://huggingface.co/models?search=medical+onnx)** — search "medical onnx".

Pair any of these with a matching modality + spacing + normalisation in your manifest, and TAMIAS will run them. See **[Bring your own model](../README.md#-bring-your-own-model)** for the full manifest schema.

## License

- `CT_AVM.nii.gz` — CC-BY-SA (from `niivue-demo-images`)
- `threshold_seg.onnx` and `threshold_seg.json` — CC0
