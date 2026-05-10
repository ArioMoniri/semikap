# TotalSegmentator in TAMIAS

TAMIAS exposes [TotalSegmentator][upstream] (whole-body anatomical
segmentation, 117+ classes) through three different runtime paths,
introduced across v0.7.4 → v0.7.7. Each has different prerequisites
and trade-offs; pick the one that matches your install.

[upstream]: https://github.com/wasserth/TotalSegmentator

## Status snapshot

| Path | Status (v0.7.x) | Best for |
|---|---|---|
| **Native Python sidecar** (Tauri-only) | ✅ shipping (v0.7.7) | macOS / Linux / Windows users with `pip install totalsegmentator` already installed. Works on any backend PyTorch supports — CUDA, MPS (Apple Silicon), or CPU. |
| **BYO ONNX URL** | ✅ shipping (v0.7.4) | Anyone who has access to a community-converted ONNX export. The TAMIAS browser ORT runtime runs it in WebGPU / WASM. |
| **Pyodide (browser)** | ⚠️ experimental, expected to fail today (v0.7.6) | Demonstration of the path forward when Pyodide ecosystem closes the SimpleITK / nnUNet gap. Wired end-to-end but blocked at install. |

The panel UI surfaces the **native** path first when running in the
Tauri desktop build, with the Pyodide attempt collapsed into a
`<details>` for inspection. When running as the browser PWA, the
native path is replaced with a "install desktop app" hint and the
BYO-URL flow becomes primary.

## Native Python sidecar (recommended)

This is the most reliable way to run TotalSegmentator inside TAMIAS.
The Tauri Rust side spawns your local install as a subprocess, streams
progress back into the UI, and reads the resulting NIfTI masks from a
temp directory.

### One-time setup

```bash
# Pick whichever you prefer.
pip install totalsegmentator
# or:
pipx install totalsegmentator
```

Verify it's on `PATH` (TAMIAS does this on launch but doing it
yourself confirms the install):

```bash
totalsegmentator --version
```

Restart TAMIAS so the path-detection probe picks the binary up. The
"On-Prem AI → TotalSegmentator" panel will switch from the install
hint to a green "Native TotalSegmentator detected" card.

### Running

1. Load a CT volume (DICOM / NIfTI / NRRD) into the radiology viewer.
2. Open the **On-Prem AI** sidebar section.
3. In the **TotalSegmentator** card, load any manifest (the BYO entry
   works) to expose the runner. The runner card is shown once a
   manifest is loaded so the panel only takes screen space when
   actively used.
4. Pick a task and click **Run TotalSegmentator on current volume**.

The runner streams `totalsegmentator` stdout / stderr line-by-line
into a progress block, capped at the most recent 200 lines. On
completion the result panel shows the temp directory + every mask
file written.

### Supported tasks

The TAMIAS runner exposes a curated subset of tasks. The full list
keeps growing upstream — pass any other task name by editing the
`<select>` options in `src/components/TotalSegmentatorPanel.tsx` (one-
line change).

| Task | Notes |
|---|---|
| `total` | 117-class whole-body. Default. |
| `lung_vessels` | Pulmonary vasculature subdivision. |
| `body` | Single-class body envelope. Quick smoke test. |
| `cerebral_bleed` | Hyperdense ICH segmentation. |
| `hip_implant` | Metal-hip artefact masking. |
| `coronary_arteries` | Cardiac CT. |
| `pleural_pericard_effusion` | Pleural / pericardial fluid. |

The `--fast` toggle resamples to 3 mm spacing before inference. ~3×
faster, slightly lower mask accuracy. Recommended on CPU; off on
GPU.

### Permissions / security

The native runner uses Rust's `std::process::Command` rather than
`tauri-plugin-shell`, so it sits outside the plugin's argument-pattern
whitelist. The trust model is identical to the manual CLI workflow:
TAMIAS only spawns the binary you yourself installed; bytes never
leave your device.

The Rust source is `src-tauri/src/totalseg.rs` (commands
`totalseg_detect`, `totalseg_run`, `totalseg_read_mask`). Read it
before installing if you'd like to verify what TAMIAS is doing — it's
< 300 lines.

### Troubleshooting

- **"Native runner unavailable"** when TotalSegmentator IS installed:
  most often a PATH issue. The binary needs to be on the `PATH`
  TAMIAS inherits, which on macOS means it must be discoverable from
  Finder-launched apps (not just shells). `pipx ensurepath` followed
  by a logout/login fixes the most common case. As a fallback, try
  invoking `python3 -m totalsegmentator --version` from a fresh
  Terminal — TAMIAS probes that too.
- **Process exited with non-zero status**: the log tail is appended
  to the error message. Common causes are missing model weights
  (TotalSegmentator downloads them on first run; ensure your network
  is up and `~/.totalsegmentator/` is writeable) and unsupported
  input modalities (the `total` task expects CT).

## BYO ONNX URL

For users who have a community-converted ONNX export of nnUNet /
TotalSegmentator (or the day a first-party export ships), the panel's
**TotalSegmentator (BYO URL)** preset opens an inline form:

- Friendly name (shown in the panel header).
- ONNX model URL (e.g. a HuggingFace `resolve/main/...` link).
- Optional SHA-256 to validate the download.

Submit downloads + caches the bytes in OPFS for instant subsequent
loads. The runtime path then runs through the existing browser ORT
worker — same WebGPU / WASM stack as SAM.

The manifest schema is documented in
`src/lib/totalseg/types.ts`; you can also load a local `.json` via
**Pick local manifest**.

## Pyodide path (experimental)

Collapsed into a `<details>` block in the panel because today it
**fails predictably** at the SimpleITK install step. Open it to:

1. Boot Pyodide from `cdn.jsdelivr.net` (~10 MB).
2. Install whatever transitive deps are available
   (`nibabel`, `numpy`).
3. Try `micropip.install("totalsegmentator")` — fails because
   `SimpleITK` has no WASM build.
4. Show the verbatim install errors per package.

The runner is wired end-to-end so the day Pyodide closes the gap
the same UI starts working. Until then, treat it as documentation
of the dependency wall — and use the native path.

## Roadmap

- v0.7.8: persistent measurement overlay, per-pane slice chips,
  documentation.
- v0.7.x: auto-load TotalSegmentator output masks back into the
  NiiVue viewer (today the user has to point the file picker at
  the temp dir manually).
- v0.8.0: streamed cancel for long-running native runs (today the
  process runs to completion).

See [`CHANGELOG.md`](../CHANGELOG.md) for the per-release detail.
