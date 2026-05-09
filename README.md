<p align="center">
  <img src="docs/assets/hero.svg" alt="TAMIAS — Transparent locAl Medical Image AnalysiS" width="100%"/>
</p>

<h3 align="center">
  Browser-only PWA · ONNX inference · DICOM / NIfTI / NRRD · WebGPU · No upload
</h3>

<p align="center">
  <a href="docs/DEPLOY.md"><strong>📦 Deploy</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/UPDATER.md"><strong>🔄 Auto-update setup</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/ROADMAP.md"><strong>🗺️ Roadmap</strong></a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md"><strong>📜 Changelog</strong></a>
</p>

<br/>

<p align="center">
  <!-- Architecture-aware direct downloads. Each link points at the most common
       installer per platform. The "all assets" line below the buttons covers
       the rest (Intel Mac, .deb, .rpm, …). -->
  <a href="https://github.com/ArioMoniri/semikap/releases/latest/download/Tamias_aarch64.dmg"><img src="docs/assets/download-macos.png" alt="Download macOS Apple Silicon (.dmg)" height="64"/></a>
  &nbsp;
  <a href="https://github.com/ArioMoniri/semikap/releases/latest/download/Tamias_x64-setup.exe"><img src="docs/assets/download-windows.png" alt="Download Windows installer (.exe)" height="64"/></a>
  &nbsp;
  <a href="https://github.com/ArioMoniri/semikap/releases/latest/download/Tamias_amd64.AppImage"><img src="docs/assets/download-linux.png" alt="Download Linux AppImage" height="64"/></a>
</p>

<p align="center">
  <sub>
    🍎 <a href="https://github.com/ArioMoniri/semikap/releases/latest/download/Tamias_x64.dmg">macOS Intel (.dmg)</a>
    · <a href="https://github.com/ArioMoniri/semikap/releases/latest/download/Tamias_x64_en-US.msi">Windows .msi</a>
    · <a href="https://github.com/ArioMoniri/semikap/releases/latest/download/Tamias_amd64.deb">Debian/Ubuntu .deb</a>
    · <a href="https://github.com/ArioMoniri/semikap/releases/latest/download/Tamias_x86_64.rpm">Fedora/RHEL .rpm</a>
    · <a href="https://github.com/ArioMoniri/semikap/releases/latest">all assets ↗</a>
  </sub>
</p>

<p align="center">
  <img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-22c55e?style=flat-square"/>
  <a href="https://github.com/ArioMoniri/semikap/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/ArioMoniri/semikap?label=version&color=1d4ed8&style=flat-square"/></a>
  <img alt="Stars" src="https://img.shields.io/github/stars/ArioMoniri/semikap?style=flat-square&color=facc15"/>
  <img alt="Forks" src="https://img.shields.io/github/forks/ArioMoniri/semikap?style=flat-square&color=22c8db"/>
  <img alt="Contributors" src="https://img.shields.io/github/contributors/ArioMoniri/semikap?style=flat-square&color=a855f7"/>
  <img alt="Open issues" src="https://img.shields.io/github/issues/ArioMoniri/semikap?style=flat-square&color=ec4899"/>
  <img alt="Total downloads" src="https://img.shields.io/github/downloads/ArioMoniri/semikap/total?label=downloads&style=flat-square&color=1d4ed8"/>
</p>

---

## ⚡ One-line install on a server

```sh
curl -fsSL https://raw.githubusercontent.com/ArioMoniri/semikap/main/install.sh | sh
```

Clones the repo into `./tamias`, runs `npm ci && npm run build`, starts the static server. Look for `TAMIAS_PORT=<port>` in the output and point your reverse proxy at that port.

> ✅ **No manual edits required.** Every override has a runtime knob (`PORT`, `HOST`, Helm values, `.env`). The literal string `placeholder` appears nowhere in source — only inside `package-lock.json` as part of an upstream Babel package's name, which is a transitive dependency of the React build toolchain and is not editable.

---

## 🎯 What it does

A clinician opens a link, picks a local image, picks a local ONNX model, and gets an AI segmentation overlay rendered on a 3-plane MPR + 3D viewer. **Bytes never leave the device.** Inference runs in the browser via WebGPU (Metal / D3D12 / Vulkan), with WebNN and a multi-threaded WASM-SIMD fallback.

```mermaid
flowchart LR
  A[📂 Local file<br/>DICOM · NIfTI · NRRD] --> B[🧠 ONNX model<br/>+ manifest.json]
  B --> C[🛠️ Worker<br/>resample · normalize · tile]
  C --> D{🚀 Backend?}
  D -- WebGPU --> E[🟦 GPU<br/>Metal / D3D12 / Vulkan]
  D -- WebNN --> EN[🟪 NPU / ANE / DirectML]
  D -- fallback --> F[🟫 WASM-SIMD<br/>multi-threaded]
  E --> G[🩻 Segmentation overlay<br/>MPR + 3D · brush correction]
  EN --> G
  F --> G
  G --> H[💾 Local save<br/>NIfTI · DICOM-SEG · repro JSON]
```

---

## ✨ Features

| | | | |
|---|---|---|---|
| 🛡️ Strict CSP — no upload | 🌐 PWA install | 🖥️ Tauri desktop builds | 🔄 Sparkle-style auto-updater |
| 🚀 WebGPU + WebNN + WASM | 🌫️ Gaussian-blended tiling | 🧱 3D sliding-window inference | 🎚️ WW/WL CT presets |
| 🛠️ Radiology toolbar (W-L · Pan · Distance) | 🩻 Outline mode for masks | 🔍 Zoom in / out · 📸 PNG screenshot | 🖼️ Layout: MPR / single-plane / 3D / grid |
| 🎨 6-colour brush + per-colour mask export | 🖌️ Brush strokes visible in 3D | 🩻 Multi-series overlay | 🔬 Cursor probe (vox · mm · value) |
| 🩻 Sidebar volume preview (mid-axial thumb) | 🔎 Cached-models search | 🌗 Light / Dark / System theme | 🪪 Modality toggle (Radiology · Pathology) |
| 🔬 Pathology mode (OpenSeadragon + OME-TIFF) | 🧠 Tile-based ONNX inference | 📏 Distance ruler in microns | 📤 Result PNG + sidecar JSON |
| 🪄 SAM (Radiology + Pathology) | 🧠 Smart-brush single-click mask | 🧭 Cross-slice propagation (±5 / ±15) | 💾 Auto-save folder (IDB-persisted) |
| 💾 NIfTI mask export | 🩻 DICOM-SEG export (PACS) | 🧾 Reproducibility bundle | 📒 Local audit log (NDJSON) |
| 💽 OPFS warm cache | 🔒 SHA-256 model verification | ❤️ `/healthz` for K8s probes | 🪪 RUO stamp on every export |

> 🔬 **Pathology mode lands in v0.6.0.** Whole-slide image viewer (OpenSeadragon-based pyramidal viewer · OME-TIFF · Aperio SVS · Hamamatsu NDPI · TIFF · PNG · JPEG), tile-based ONNX inference (segmentation / classification / heatmap / detection), MPP-aware distance ruler, six-colour brush + eraser with per-colour PNG export. Bundled CC0 synthetic H&E sample for end-to-end testing. Full reference: [`docs/PATHOLOGY.md`](docs/PATHOLOGY.md). Roadmap: [`docs/ROADMAP.md#v060--pathology-mode`](docs/ROADMAP.md#v060--pathology-mode).
>
> 🪄 **SAM (Segment Anything) ships in v0.7.0** — click + box + text prompts → mask, in **both** Radiology and Pathology modes. One-click HuggingFace download (SAM 2 Tiny ~30 MB, SAM 2 Base+ ~80 MB, MedSAM ~360 MB) or bring your own ONNX export. Encoder runs once per slice / ROI on WebGPU; decoder is sub-100 ms per prompt revision so refinement is interactive. **Smart-brush** in the radiology Annotation panel (single click → mask straight into the brush layer, no Encode/Generate/Commit roundtrip). **Cross-slice propagation** (±5 / ±15 slices) walks neighbours using each previous mask's bbox as a prompt. **Auto-save folder** for screenshots persisted across sessions via IndexedDB. **No upload**, weights cached in OPFS, SAM 3 BYO URL slot ready for when a stable export ships. Full plan + status table: [`docs/SAM.md`](docs/SAM.md).

---

## 🚀 Deploy

| Path | Command | When to pick |
|---|---|---|
| **Node only** | `npm run setup` | Single-machine, simplest |
| **Docker** | `docker compose up -d --build` | Single host, containerised |
| **Helm** | `helm install tamias deploy/helm/tamias` | Departmental K8s |
| **systemd** | `systemctl enable --now tamias` | Long-running on a box |
| **Tauri desktop** | `npm run desktop:build` | Native app per workstation |

→ Full setup, reverse-proxy snippets, and configuration table: **[docs/DEPLOY.md](docs/DEPLOY.md)**

---

## 🔄 Auto-updates (Tauri Sparkle-style)

Desktop installs self-update from a **signed** `latest.json` manifest published with each release. Sparkle-style on macOS / Windows / Linux via Tauri's official updater plugin.

**Brand new machine?** Step-by-step from cloning to first release: **[docs/UPDATER.md → "From zero on a brand-new machine"](docs/UPDATER.md#-from-zero-on-a-brand-new-machine)**

**TL;DR for an existing checkout:**

```sh
node scripts/init-updater.mjs    # one-time keypair generation (maintainer)
node scripts/release.mjs minor   # cut + push v0.3.0; CI signs + publishes installers
```

→ Full setup + signing-key flow: **[docs/UPDATER.md](docs/UPDATER.md)**

---

## 📦 Bring your own model

TAMIAS ships no model weights. The user supplies an `.onnx` (or `.ort`) plus a sidecar `.json` manifest:

```json
{
  "name": "MyLiverSeg",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "modality": "CT",
  "spacing": [1.5, 1.5, 1.5],
  "orientation": "RAS",
  "normalization": { "type": "window", "level": 50, "width": 400 },
  "inference": { "type": "sliding_window", "patch": [128, 128, 128], "overlap": 0.25 },
  "output": {
    "type": "segmentation",
    "labels": { "0": "background", "1": "liver" },
    "colors": { "1": "#22c55e" }
  },
  "preferredEP": "webgpu",
  "tta": { "flips": { "x": true } },
  "sha256": "<optional hex hash of the .onnx file>"
}
```

If `sha256` is present it's verified against the loaded ONNX bytes before the session is created.

---

## 🗺️ Repo map

The diagram below regenerates on every push to `main` ([repo-visualizer](https://github.com/githubocto/repo-visualizer) by [GitHub Next](https://githubnext.com/projects/repo-visualization/)). A schematic placeholder is committed to the repo so this image always renders, even before the workflow has run.

<p align="center">
  <a href="docs/assets/repo-visualization.svg"><img src="docs/assets/repo-visualization.svg" alt="TAMIAS repo visualization" width="100%"/></a>
</p>

---

## 📈 Star history

<a href="https://star-history.com/#ArioMoniri/semikap&Date">
  <img src="https://api.star-history.com/svg?repos=ArioMoniri/semikap&type=Date" alt="TAMIAS star history" width="100%"/>
</a>

---

## 📚 Docs

- **[examples/](examples/)** — drop-in 3-file test kit (CT NIfTI + tiny ONNX + manifest, ~470 KB) for an end-to-end smoke test
- **[ROADMAP](docs/ROADMAP.md)** — phased delivery & what's next
- **[DEPLOY](docs/DEPLOY.md)** — every supported deploy mode + reverse-proxy + configuration
- **[UPDATER](docs/UPDATER.md)** — auto-update setup, signing keys, release flow, **from-zero new-machine guide**
- **[SIGNING](docs/SIGNING.md)** — Apple Developer code-signing + notarisation (fix the "DMG is damaged" warning), Windows Authenticode
- **[CHANGELOG](CHANGELOG.md)** — release notes
- **[CONTRIBUTING](CONTRIBUTING.md)** — what we accept and the dev loop
- **[SECURITY](SECURITY.md)** — threat model and reporting

## ⚖️ License

[Apache-2.0](LICENSE) © 2026 Ariorad Moniri and TAMIAS contributors.
