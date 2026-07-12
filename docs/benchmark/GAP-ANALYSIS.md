# Benchmarking — Doc → Implementation Gap Analysis

Auditing every feature in the source docs (TAMIAS Benchmarking Plan §4/§5/§6/§9,
Assess-AI Ingest Spec v2.1, Data Dictionary, Report User Guide) against what is
actually implemented, so nothing specified is silently dropped.

Legend: ✅ done · 🟡 partial · ❌ missing (this pass closes 🟡/❌ where feasible).

## §4 Benchmarking feature roadmap

| Feature | Status before | This pass |
|---|---|---|
| Model registry (name/task/version/license/source URL/checksum/opset/IO shapes/preproc/postproc/intended use/limitations) | 🟡 (no source URL, intended use, limitations, IO shapes) | add sourceUrl, intendedUse, limitations, input shapes |
| ONNX validator (loadability/opset/unsupported ops/input dims/precision/normalization/runtime compat) | 🟡 (opset/IO names/nodes) | add input **shapes** + tensor **precision** from graph |
| Dataset manifest (modality/anatomy/date/scanner/dims/slice thickness/contrast/GT availability/de-id) | 🟡 | add scanner/dims/deidentified fields |
| Reference-label import (DICOM-SEG, RTSTRUCT, NIfTI masks, JSON/CSV labels, bounding boxes, reader labels) | ❌ (only loaded-volume/prior-result) | **NIfTI/NRRD mask files, CSV/JSON labels, bounding-box JSON**; DICOM-SEG/RTSTRUCT remain (large parsers) |
| Metric engine (classification/detection/segmentation/calibration/runtime/agreement/subgroup/failure-mode) | 🟡 (seg+cls+runtime+subgroup) | **detection metrics**, calibration already in cls, failure-mode capture |
| Comparison dashboard (side-by-side/metric tables/threshold sliders/runtime charts/agreement plots/case review) | 🟡 (tables+runtime) | **threshold slider, runtime chart, agreement/plots, case-level review** |
| Assess-AI completeness (AI result/DICOM/reference/model version/inference date) | ✅ | keep |
| Concordance (AI-vs-ref/report/reader/model-model, discordant drilldown) | 🟡 (rate+CI+ids) | **discordant-case table + adjudication + reason categories** |
| Report export (PDF/DOCX/CSV/JSON/model-card/audit log/repro bundle) | 🟡 (HTML+CSV+JSON+card) | add **audit-log + repro-bundle** into report; PDF via browser print of HTML |
| Local privacy checks (offline mode/network log/no-upload/PHI warnings) | 🟡 (static report) | **network-request log + PHI/de-id warning heuristic** |

## §5 Metrics + plots

| Task | Metrics | Plots | This pass |
|---|---|---|---|
| Classification | ✅ AUROC/AUPRC/acc/sens/spec/PPV/NPV/F1/Brier/ECE | ❌ ROC/PR/calibration/confusion/threshold table | **all plots + threshold table (SVG)** |
| Detection | ❌ | ❌ FROC/threshold table/missed-lesion | **lesion sens, FP/image, FROC, mAP, localization err + FROC plot** |
| Segmentation | ✅ Dice/IoU/HD95/ASSD/vol diff | 🟡 (per-structure table) + ❌ Bland-Altman/vol-corr | **volume correlation + Bland-Altman plot** |
| Platform | 🟡 load/infer/total/provider | ❌ runtime distribution | **runtime histogram + failure rate** |
| Robustness/subgroups | ✅ by modality/body/age/sex/contrast | ❌ forest plot | **subgroup forest plot + image-size band** |
| Concordance | 🟡 rate/CI | ❌ discordant table | **discordant table + adjudication** |

## Execution batches (this pass)

1. **Imports**: `datasets/nifti-mask.ts` (NIfTI-1, gz via DecompressionStream), `datasets/labels.ts` (CSV/JSON), `datasets/boxes.ts` (bbox JSON).
2. **Detection**: `metrics/detection.ts` (matching, sensitivity, FP/image, FROC, mAP, localization error).
3. **Plots (pure data)**: `plots/*.ts` → ROC, PR, calibration, confusion, Bland-Altman, forest, histogram; rendered by small SVG components.
4. **Depth**: `benchmark/adjudication.ts` (status + reason categories), richer registry entry, network/PHI privacy, repro+audit in report.
5. **UI wiring**: classification E2E (CSV labels + threshold), detection E2E, reference file import, plots, discordant drilldown, richer registry form.
6. **Comprehensive smoke test of every feature.**

Remaining hard items explicitly deferred (documented, not silently dropped):
DICOM-SEG + RTSTRUCT reference parsing (multi-frame segmentation object + RT
structure sets — large, error-prone binary parsers), and multi-site/national
concordance comparison (needs data TAMIAS deliberately never collects).
