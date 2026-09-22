# Zenodo liver models → TAMIAS ONNX

Converts two Zenodo records to ONNX + TAMIAS manifests:

| Record | Content | License |
|---|---|---|
| [10.5281/zenodo.21037952](https://doi.org/10.5281/zenodo.21037952) | LightningMedSeg3D state_dicts: unet, vnet, resunet, attention_unet, unetpp, unetr, swin_unetr, medformer, segformer | weights CC-BY-4.0, code AGPL-3.0-or-later |
| [10.5281/zenodo.11582728](https://doi.org/10.5281/zenodo.11582728) | nnU-Net v2 `Dataset006_Liver.zip` (liver + lesion, LiTS 2017) | CC-BY-4.0 |

CI does the conversion in `.github/workflows/zenodo-models.yml` and publishes to the
pre-release [`zenodo-models-v1`](https://github.com/ArioMoniri/semikap/releases/tag/zenodo-models-v1).

## Run it locally (one command)

You need Python 3.10–3.12, about 8 GB of free disk and internet access to zenodo.org. From the repo root:

```bash
python3 -m venv .venv-zenodo && . .venv-zenodo/bin/activate && pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cpu && pip install -r scripts/zenodo/requirements.txt && python scripts/zenodo/fetch.py --out work && python scripts/zenodo/export_onnx.py lms3d --weights-dir work/lms3d --out dist && python scripts/zenodo/export_onnx.py nnunet --model-dir work/nnunet/extracted --out dist && python scripts/zenodo/export_onnx.py index --out dist
```

Output in `dist/`:

- `lms3d_<arch>.onnx` + `lms3d_<arch>.json`, one pair per architecture
- `nnunet_liver_lits.onnx` + `nnunet_liver_lits.json`
- `zenodo-models-index.json` (schema `tamias.model-index.v1`)
- `*.report.json` for each model, with parity numbers and the reason for any failure

Load a model in TAMIAS with its `.onnx` and `.json` together.

## What the scripts do

- `fetch.py` downloads every file through the Zenodo REST API and checks its md5. It checks each `.pth` against `CHECKSUMS.sha256` too. It extracts the nnU-Net zip and then deletes the zip.
- `export_onnx.py` does the following:
  - It looks up the sha256 of each LightningMedSeg3D `.pth` in `metadata.json` → `weights_index` to find which dataset it was trained on. The flat files in this record match **BTCV**, which has 14 classes (background plus 13 organs). The Task03 weights, which would have 3 classes, are listed in the metadata but not shipped.
  - It builds each network with the hyperparameters of the training toolkit. That toolkit is MedicalLiverSegmentationToolKit, and its BTCV configs give UNet++ `base_chan=10`, SwinUNETR `feature_size=36` and the full MedFormer config. If those don't fit, it falls back to the `lightning_medseg3d` factory. The weights must load strictly. The only exception is MONAI ≥ 1.4's unused `cross_attn` parameters.
  - It wraps each network so that it matches the TAMIAS contract. The input is float32 `[1,1,PZ,PY,PX]` in stored voxel order. The output is logits `[1,C,PZ,PY,PX]`. The export uses opset 17, fixed shapes and fp32.
    - **LightningMedSeg3D:** the graph permutes the axes `[z,y,x]→[x,y,z]` (MONAI) and back. The model's `ScaleIntensityRange(-175..250 → 0..1, clip)` is exactly TAMIAS `window` normalisation with level 37.5 and width 425, so the manifest carries it and it is not baked in. Spacing is 1.5×1.5×2.0 mm and the patch is 96³.
    - **nnU-Net:** `CTNormalization` is baked into the graph. It clips to the [p0.5, p99.5] range from the plans fingerprint, then applies a z-score. `transpose_forward` is baked in too, and the manifest uses `normalization: none`. Patch and spacing come from `plans.json`, with the axes reversed to TAMIAS `[x,y,z]` order. The script exports fold `all` if it exists, otherwise fold 0.
  - It runs a parity check. PyTorch runs each model's own reference preprocessing (MONAI-style `[x,y,z]` for LightningMedSeg3D, nnU-Net's `CTNormalization` class for nnU-Net). ONNX Runtime runs the TAMIAS-side preprocessing. Both run on a random-HU patch and a synthetic CT phantom. The check reports the largest absolute difference in logits and the fraction of voxels where the argmax agrees.

## Caveats

- TAMIAS does not currently apply `manifest.orientation`. The worker feeds the volume in its stored voxel order.
  - The LightningMedSeg3D models were trained on volumes reoriented to RAS. On NIfTI files stored in a different orientation, for example LPS from dcm2niix, they see flipped axes.
  - nnU-Net never reoriented its input, so it matches TAMIAS's behaviour.
- TAMIAS resamples with trilinear interpolation. The LightningMedSeg3D toolkit resampled images with nearest-neighbour, and nnU-Net uses third-order splines. Expect small differences near boundaries.
- These models are for research use only. Do not use them for clinical decisions.
