# TAMIAS — Model Loading Guide

This doc tells you, for every model TAMIAS knows about:

- **What works one-tap**, **what needs BYO URL**, **what can't run in
  the browser at all**.
- The technical reason for the bucket.
- Exact URLs and step-by-step instructions to load it.

Last reviewed: **2026-05-11** for v0.7.9.

---

## 1. Quick reference

| Model | Status | Action |
|---|---|---|
| **SAM 2.1 Tiny** | ✅ One-tap | Click "SAM 2.1 Tiny" in the SAM panel |
| **SAM 2.1 Base+** | ✅ One-tap | Click "SAM 2.1 Base+" in the SAM panel |
| **MedSAM** | ✅ One-tap | Click "MedSAM" in the SAM panel |
| **SAM 3 (Meta, 2026)** | ⚠️ BYO URL or local zip | See §3 |
| **TotalSegmentator** | ❌ Cannot run in-browser | Run upstream Docker, load `.nii.gz` overlay (§4) |
| **nnUNet (any task)** | ❌ Cannot run in-browser | Same as TotalSegmentator (§4) |
| **MONAI bundles** | ⚠️ Manual ONNX export needed | See §5 |
| **Custom HF ONNX export** | ✅ BYO URL | Click "Custom URL…" in the SAM panel |

---

## 2. One-tap presets — how they work

When you click a one-tap preset:

1. Tamias fetches the encoder + decoder ONNX files from HuggingFace.
2. The bytes are streamed straight into OPFS (origin-private filesystem)
   — no temp file on disk, no server in the middle.
3. ORT-Web (ONNX Runtime) loads the bytes into a WebGPU session.
4. The model lives entirely on your device after the first download.

Verified URLs (you can confirm these in DevTools → Network):

```
SAM 2.1 Tiny    https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/vision_encoder_quantized.onnx
                https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx

SAM 2.1 Base+   https://huggingface.co/onnx-community/sam2.1-hiera-base-plus-ONNX/resolve/main/onnx/vision_encoder_quantized.onnx
                https://huggingface.co/onnx-community/sam2.1-hiera-base-plus-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx

MedSAM          https://huggingface.co/Xenova/medsam-vit-base/resolve/main/onnx/vision_encoder_quantized.onnx
                https://huggingface.co/Xenova/medsam-vit-base/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx
```

If a one-tap preset fails, it's almost always one of:

- **CSP block** (`Refused to connect to https://cas-bridge.xethub.hf.co/...`).
  Fixed in v0.7.9 by allowing the new HuggingFace Xet storage origin.
  If you're on v0.7.8 or earlier, upgrade.
- **Network** (HF CDN slow/down). Click the new **Retry** chip.
- **OPFS quota** (rare; you'd need ~5 GB pre-cached).

---

## 3. SAM 3 — the "almost one-tap" case

### Why it's not one-tap yet

Meta released SAM 3 in 2026. Three relevant repos exist:

| Repo | Format | Why it's not one-tap |
|---|---|---|
| `facebook/sam3` | `.safetensors` only | No ONNX export upstream. PyTorch checkpoint won't run in a browser. |
| `onnx-community/sam3-tracker-ONNX` | ONNX **with external-data sidecar** | The model uses ONNX's external-data format: each `.onnx` graph file has a sibling `.onnx_data` containing the weights. Our v0.7.9 loader only reads single-file `.onnx`. External-data support lands in v0.8.x. |
| `vietanhdev/segment-anything-3-onnx-models` | Single zip (~3.41 GB ViT-H, Apache-2.0) | Single self-contained zip — closest one-tap drop-in once unzipped locally. |

### How to load SAM 3 today (vietanhdev path — recommended)

1. Download the zip from `https://huggingface.co/vietanhdev/segment-anything-3-onnx-models/resolve/main/sam3_vit_h.zip` in a regular browser.
2. Unzip locally — you'll get `encoder.onnx`, `decoder.onnx`, and a manifest.
3. In Tamias → SAM panel → **Pick local manifest + ONNX** → select the
   `manifest.json` first, then encoder, then decoder when prompted.
4. The model loads into OPFS the same way a preset would; future
   sessions reuse the cached copy.

### How to load SAM 3 today (onnx-community BYO URL path — partial, advanced)

This path won't work in v0.7.9 because of the external-data sidecar.
v0.8.x will add support, then:

1. SAM panel → **Custom URL…**
2. Name: `SAM 3 Tracker`
3. Encoder URL:
   `https://huggingface.co/onnx-community/sam3-tracker-ONNX/resolve/main/onnx/vision_encoder_q4f16.onnx`
4. Decoder URL:
   `https://huggingface.co/onnx-community/sam3-tracker-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder.onnx`

Quantization variants (smaller = faster, slightly lower quality):

| Variant | Vision encoder size | Notes |
|---|---|---|
| fp32 | 1.87 GB | Best quality, slowest |
| fp16 | 935 MB | Balanced |
| `q4f16` | **296 MB** | Recommended starter |
| `quantized` (int8) | 527 MB | Falls back to CPU on some GPUs |

---

## 4. TotalSegmentator (and any nnUNet task) — cannot run in-browser

### Why

This is the most-requested feature and the hardest to deliver. The
honest reason:

1. **TotalSegmentator is a 5-fold nnUNet ensemble.** Each "model" is
   actually 5 separate networks whose outputs get averaged.
2. **nnUNet uses sliding-window inference with dynamic patching.**
   The image is broken into overlapping 3D patches at runtime, each
   patch is run through the network, and the outputs are stitched
   back together with Gaussian weighting. This control flow can't
   be expressed as a single static ONNX graph.
3. **No community export exists** — confirmed via the v0.7.9
   researcher pass. People have asked for years; no one has shipped
   one because it's not a single file conversion, it's a code
   rewrite.

So there's no "ONNX URL" we could point you at, and no "license
acceptance" UI that would unlock automated download — the upstream
project simply doesn't ship the format we'd need.

### What to do instead — the recommended workflow

This is what professional radiology workstations actually do too:
**run inference outside the viewer, load the result as an overlay.**

#### Option A — Docker (easiest)

```bash
docker pull wasserth/totalsegmentator:latest
docker run --gpus all --rm -it \
  -v /path/to/your/dicom:/input \
  -v /path/to/output:/output \
  wasserth/totalsegmentator:latest \
  TotalSegmentator -i /input -o /output
```

This produces a `segmentations.nii.gz` (or per-organ `.nii.gz` files).

#### Option B — Python (if you have a CUDA box)

```bash
pip install totalsegmentator
TotalSegmentator -i your_ct.nii.gz -o output_dir
```

#### Loading the result back into Tamias

1. Open the original CT in Tamias as the primary volume.
2. Sidebar → **Add overlay** (or drag `segmentations.nii.gz` onto the
   viewer).
3. Tamias renders the multi-label mask using its `roi_i256` colormap
   (each anatomy gets a distinct colour).

You now have the same result as if Tamias had run TotalSegmentator
itself — the pixels never leave your device after the upstream
inference completes.

#### When this might change

- If the nnUNet team ships ONNX export support upstream → we can ship
  TotalSegmentator as a one-tap preset.
- If MONAI's "wholebody_ct_segmentation" bundle gets an ONNX export →
  that's a different (smaller, single-network) wholebody model we
  could bundle. As of 2026-05-11, it's PyTorch only.

---

## 5. MONAI bundles — manual ONNX export

MONAI ships dozens of medical-imaging models as "bundles." Most are
PyTorch checkpoints. To use one in Tamias:

1. Find the bundle: https://monai.io/model-zoo.html
2. Convert to ONNX with MONAI's built-in exporter:
   ```python
   from monai.bundle import ckpt_export
   ckpt_export(
       net_id="network_def",
       filepath="model.onnx",
       ckpt_file="models/model.pt",
       config_file="configs/inference.json",
       input_shape=[1, 1, 96, 96, 96],
   )
   ```
3. Upload the `.onnx` to a HuggingFace repo (or any HTTPS host with
   CORS open).
4. In Tamias → SAM panel → **Custom URL…** → paste the URL.

Caveat: MONAI bundles aren't SAM-compatible — they have no encoder/
decoder split. To use them in Tamias today you'd treat them as a
single-network overlay generator. Multi-network manifest support is
in the v0.8.x roadmap.

---

## 6. Custom HF ONNX exports — the universal escape hatch

For ANY HuggingFace ONNX repo with separate encoder + decoder files:

1. Find the URLs. Pattern:
   ```
   https://huggingface.co/<org>/<repo>/resolve/main/<path>/<file>.onnx
   ```
2. SAM panel → **Custom URL…**
3. Fill in name + encoder URL + decoder URL.
4. Click **Download & load**.

The downloaded bytes go straight to OPFS. Subsequent loads reuse the
cached copy.

### What "compatible" means

The model has to follow the SAM-style two-network split:

- **Encoder**: takes a normalised image tensor → outputs a fixed-size
  embedding tensor.
- **Decoder**: takes the embedding + prompts (points, boxes, masks)
  → outputs a logits tensor that can be thresholded into a binary
  mask.

If the model is a single-network classifier or a U-Net that takes the
full image directly, it won't fit the SAM panel — it needs a
different runner. The TotalSegmentator section above is the canonical
example of "doesn't fit."

---

## 7. Why we use ONNX

For people new to the format:

- **ONNX = Open Neural Network Exchange.** A frozen graph format
  that captures the network topology and weights in a single
  language-neutral file.
- **ONNX Runtime Web (ORT-Web)** is the JS/WASM library that
  executes ONNX graphs in a browser, with WebGPU acceleration on
  modern hardware.
- ONNX is **not** a magic conversion — the original PyTorch / TF
  model has to be exported with a tracer that hits every code path.
  Models with dynamic control flow (like nnUNet's sliding window)
  trip up the exporter.

If you have a model in another format (TFLite, CoreML, etc.) it
won't load in Tamias today. Convert to ONNX first; the Hugging
Face `transformers.js` docs have decent guides for the common
architectures.

---

## 8. Troubleshooting download failures

| Console error | Meaning | Fix |
|---|---|---|
| `Refused to connect to https://cas-bridge.xethub.hf.co/...` | CSP block (HF Xet redirect) | Upgrade to v0.7.9+ |
| `Refused to connect to ipc://localhost/...` | Dev-mode IPC CSP block | Upgrade to v0.7.9+ (or in dev: `npm run tauri dev` from v0.7.9 source) |
| `Failed to fetch` (no detail) | Network or CORS | Check DevTools → Network for the actual response. If 401/403, the repo is gated → §9 |
| `Worker failed to load` | OPFS quota or corrupted cache | Settings → "Forget cached models" → retry |
| `Some nodes were not assigned to the preferred execution providers` (warn only) | ORT fallback to CPU for shape ops | Cosmetic. Decode still runs on GPU. |

---

## 9. Gated HuggingFace repos

Some research-licensed Meta exports require an HF account and a
license click-through. For now Tamias can't open these — the loader
sends no `Authorization` header, so the request fails with `401`.

If you need a gated repo:

1. Download the `.onnx` files in a regular browser (after accepting
   the license).
2. Use **Pick local manifest + ONNX** to load them from disk.

Direct OAuth/token support is on the v0.8.x roadmap — it needs a
secure token storage flow that doesn't leak the token to logs or
IPC.
