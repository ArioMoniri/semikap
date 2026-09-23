# Model & Dataset Catalogue — benchmark published models on public data

TAMIAS ships a catalogue of **published liver-CT segmentation models** and **public datasets**
so you can run several models on the same cases and compare them statistically, per dataset
and across datasets. The browser app and the desktop app are both fully local: images are
downloaded to your device and never uploaded.

## What's in it

| Models | Source | Trained on | Output labels |
|---|---|---|---|
| LightningMedSeg3D ×9 — U-Net, V-Net, Res-UNet, Attention U-Net, UNet++, UNETR, SwinUNETR, MedFormer, SegFormer | [Zenodo 21037952](https://zenodo.org/records/21037952) (CC-BY-4.0 weights · AGPL-3.0 code) | BTCV (13 organs) | liver = 6 (no tumour class) |
| nnU-Net v2 liver + lesions (3d_fullres) | [Zenodo 11582728](https://zenodo.org/records/11582728) | LiTS 2017 | liver = 8, tumour = 9 |

| Datasets | Access | Ground truth | Role |
|---|---|---|---|
| **HCC-TACE-Seg** (TCIA, CC BY 4.0, doi:10.7937/TCIA.5FNA-0924) | **one click, straight from TCIA** through the NCI Imaging Data Commons public bucket | expert DICOM-SEG: liver, mass, portal vein, aorta | external test set for all models |
| MSD Task03 Liver (LiTS, CC BY-SA 4.0) | download (29 GB tar) or `scripts/bench/data/fetch_msd_cases.py` (pinned byte ranges) | liver, tumour | training data of nnU-Net (resubstitution, flagged † in reports), external for LMS3D |
| BTCV (Synapse syn3193805, Landman 2015; Synapse terms) | download | 13 organs (liver = 6) | in-distribution for LMS3D |

The PyTorch checkpoints can't run in a browser. `.github/workflows/zenodo-models.yml` downloads
them from Zenodo, exports them to ONNX, checks PyTorch-vs-ONNX parity, writes TAMIAS manifests,
and publishes everything as the `zenodo-models-v1` release. The catalogue loads from that
release and keeps the Zenodo DOIs as provenance.

## Use it in the app

1. **Sidebar → Catalogue → Dataset:** choose *HCC-TACE-Seg*, pick a case, click **Load CT + GT**.
   TAMIAS lists the series on IDC and downloads the annotated contrast phase (these series hold
   up to 3 phases). It then maps the DICOM-SEG onto the CT grid using DICOM geometry and sets it
   as the **Benchmark reference**.
2. **Models:** click **Load** on any model (sha256-verified, cached locally after the first download).
3. **Inference → Run**, then **Benchmark → Score vs reference**. Each model's own labels are
   mapped to *whole liver (liver ∪ tumour)* and *tumour*.
4. Repeat for more models and cases. **Benchmark → Multi-model & cross-dataset comparison →
   Full report** shows:
   - Friedman test, mean ranks and Nemenyi critical difference for each dataset;
   - Holm-corrected pairwise Wilcoxon p-value heatmap;
   - per-case score strips;
   - each model's shift between datasets (Mann-Whitney U).

**Desktop vs browser:** GitHub release downloads send no CORS headers. The desktop app downloads
models through a native command (`catalog_fetch`, with a host allowlist checked on every
redirect). The browser build uses a CORS-friendly Hugging Face mirror when one is published;
otherwise it shows a **Download manually** link, and you drop the file into the Model panel.
HCC-TACE-Seg loads in both builds.

## Run the whole benchmark (headless, reproducible)

`.github/workflows/benchmark.yml` (Actions → *Catalogue benchmark* → Run workflow):

1. **Fetch the data.**
   - HCC-TACE-Seg from TCIA's IDC bucket (`scripts/bench/data/fetch_hcc_tace_seg.py`, QC'd and
     deterministic).
   - MSD cases by byte range (`fetch_msd_cases.py`).
2. **Run every model on every dataset in parallel** with `scripts/bench/run-benchmark.ts`. This is
   TAMIAS's own pipeline (reorient → resample → normalise → sliding window → inverse), with the
   onnxruntime-node backend.
3. **Publish** `records.ndjson` (tamias.benchmark.v1), `run.log` and the predicted masks as the
   `benchmark-results-v1` release.

Tables:

```sh
npx vite-node scripts/bench/analyze.ts -- --records records.ndjson --out tables/
```

This writes per-case, summary, Friedman, pairwise and cross-dataset CSVs plus `REPORT.md`. They use
the same statistics code as the UI. Import `records.ndjson` into the app (**Benchmark → Import
records**) to see the same results as charts.

Screenshots: `scripts/bench/screenshots.mjs` (browser) and `scripts/bench/tauri-e2e.mjs` (desktop,
via `tauri-driver`).

## Notes and limitations

- LightningMedSeg3D checkpoints are BTCV multi-organ models. Only the liver label is scored; they
  have no tumour output.
- HCC-TACE-Seg liver GT is Liver ∪ Mass and excludes intrahepatic portal-vein voxels (segmented
  separately), so liver Dice there is slightly conservative for every model.
- Skipped HCC cases (QC):
  - HCC_001: SEG/CT slice mismatch;
  - HCC_008, HCC_010, HCC_011: phases on different z-grids;
  - HCC_012: arterial phase only.
- **Known issue: 3D inference in the Linux desktop app.** On Linux the desktop webview
  (WebKitGTK) runs single-threaded WASM. During 3D inference its web process passes WebKit's
  8 GB memory limit and gets killed. Everything else works there: catalogue, native model
  download, TCIA case + GT, scoring of imported results. For now, run models in the browser
  build (SegFormer on HCC_002: 28.6 s) or with the headless runner.
- Raw model outputs are scored as-is (no largest-connected-component post-processing), so
  distant false positives show up in HD95.

## Statistics and sensitivity analyses

- Reports flag with † any model scored on its own training data. The flag comes from `trainedOn` in `src/lib/catalog/catalog.ts`.
- Surface-metric failures are scored as the worst observed value and counted, never dropped. This covers any case where only one of the two masks is empty.
- With ≤ 10 cases, Holm-corrected pairwise Wilcoxon cannot reach significance, and the report says so. Use the Nemenyi CD pairs and the paired bootstrap CIs instead.
- `scripts/bench/rescore.ts` re-scores the saved masks without re-running inference, in two ways:
  - after keeping only the prediction's largest 3-D connected component;
  - against a reference whose enclosed holes (vessels) are filled per slice.
  
  Feed either output to `analyze.ts` or to the app's *Import records*.
