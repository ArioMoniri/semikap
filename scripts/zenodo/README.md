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
    - **nnU-Net:** Dataset006_Liver is `3d_fullres`. Its plans give patch 128³, spacing z,y,x = 1.0, 0.7676, 0.7676 mm, `transpose_forward=[0,1,2]` and **`ZScoreNormalization`**.
      - ZScoreNormalization is applied per volume: `(x - mean(volume)) / std(volume)`.
      - The manifest therefore uses TAMIAS `{"type":"zscore_volume"}`, and the index sets `exactNormalization: true`.
      - If `zscore_volume` is unavailable, you can use a fixed `zscore` with mean -500 and std 495 instead. These are the median whole-volume statistics of 8 LiTS/MSD-Task03 CTs.
      - If a future plan uses `CTNormalization`, the script bakes the clip at [p0.5, p99.5] followed by a z-score into the graph instead.
      - The script exports fold `all` if it exists, otherwise fold 0. Folds 0 to 4 ship, and the ensemble is not exported.
      - `dataset.json` declares **10 labels**: 0 background, 1 spleen, 2 kidneys, 3 pancreas, 4 stomach, 5 heart, 6 duodenum, 7 `tumsomething`, 8 liver, 9 tumor. The names are copied verbatim, including `tumsomething`. Liver is label 8 and the liver lesion is label 9.
  - It runs a parity check. PyTorch runs each model's own reference preprocessing (MONAI-style `[x,y,z]` for LightningMedSeg3D, nnU-Net's `CTNormalization` class for nnU-Net). ONNX Runtime runs the TAMIAS-side preprocessing. Both run on a random-HU patch and a synthetic CT phantom. The check reports the largest absolute difference in logits and the fraction of voxels where the argmax agrees.

## Orientation

TAMIAS reorients each volume to `manifest.orientation` before resampling. It uses nibabel `aff2axcodes` semantics, so axis 0 (x, fastest-varying) points toward `orientation[0]`. It then builds the ONNX input as `[1,1,Z,Y,X]`. Every manifest here uses **RAS**.

- **LightningMedSeg3D:** the training toolkit applies MONAI `Orientationd(axcodes="RAS")` and feeds the network tensors shaped `[B,C,x,y,z]`. The graph therefore applies `permute(0,1,4,3,2)` on the way in and on the way out.
- **nnU-Net:** nnU-Net never reorients. It trains on the stored voxel order, read as a SimpleITK array `[z,y,x]` and then permuted by `transpose_forward`, and that permutation is baked into the graph. The LiTS / MSD Task03 NIfTIs are stored with RAS axis codes and a positive-diagonal affine. This was checked on 8 MSD Task03 headers read by range request from the MSD S3 tarball. Reorienting to RAS therefore reproduces the training layout.

## Hugging Face mirror (optional)

If the repository secret `HF_TOKEN` is set, CI runs `hf_mirror.py`, which does the following:

1. It uploads every asset, plus the Zenodo LICENSE and CITATION files and a model card, to `<hf-user>/tamias-zenodo-liver-models`.
2. It writes `"mirrors": ["https://huggingface.co/<user>/tamias-zenodo-liver-models/resolve/main"]` into the index.

Without the token, the step is skipped.

## Caveats

- TAMIAS resamples with trilinear interpolation. The LightningMedSeg3D toolkit resampled images with nearest-neighbour, and nnU-Net uses third-order splines. Expect small differences near boundaries.
- These models are for research use only. Do not use them for clinical decisions.
