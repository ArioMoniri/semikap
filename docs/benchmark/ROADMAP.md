# TAMIAS Radiology Benchmarking — Roadmap

Turn the TAMIAS radiology workspace into a **per-user, local, privacy-preserving
benchmarking tool**: each user logs into a local profile, registers their own
ONNX models, points them at their own imaging + reference labels, runs them, and
sees a standardized metric comparison — all on-device, no upload, no backend.

This roadmap adapts `TAMIAS_Benchmarking_and_Article_Plan.docx` (§4 feature
roadmap, §5 metrics, §9 phased plan) and the ACR **Assess-AI** field schemas
(Ingest Spec v2.1 + Data Dictionary) to the actual codebase.

## Design constraints (non-negotiable)

- **No backend, no upload.** TAMIAS is a browser-only PWA / Tauri desktop app.
  "Login" = a **local profile** (name + optional passphrase) that namespaces
  local storage. "Benchmarks are per user, not a public marketplace" = per-profile
  isolation of models, datasets, and runs. No cross-user or public leaderboard.
- **Privacy.** Reference labels and images stay in OPFS/on-disk. Records store
  file **names + SHA-256**, never PHI bytes — mirroring `src/lib/export/repro.ts`.
- **Reuse, don't fork.** Build on the existing manifest validator, OPFS model
  cache, repro bundle, and inference worker rather than parallel machinery.

## Architecture map (what we build on)

| Concern | Existing foundation | Benchmark addition |
|---|---|---|
| Model manifest | `src/lib/inference/manifest.ts` (`ModelManifest`) | ONNX validator + registry entry |
| Model bytes | `src/lib/fs/opfs.ts` (SHA-256 cache) | per-profile registry over the cache |
| A run happened | `src/lib/export/repro.ts` (`tamias.repro.v1`) | `tamias.benchmark.v1` record |
| Audit trail | `src/lib/fs/audit.ts` (NDJSON) | per-profile benchmark NDJSON store |
| Grid alignment | `src/lib/inference/postprocess.ts` (`resampleNearest`) | align reference↔prediction |
| Metrics | — (greenfield) | `src/lib/metrics/*` |
| UI panels | `src/components/AppShell.tsx` `CollapsibleSection`s | `BenchmarkPanel`, `WorkspacePicker` |
| State | `src/lib/state/store.ts` (zustand) | profile + benchmark slice |

> **Status:** Phase 1 shipped in **v0.11.0**. Phases 2–4 implemented as engines +
> UI and landed under CHANGELOG `[Unreleased]` (no release yet). Remaining larger
> items: DICOM-SEG/RTSTRUCT reference import and a full dataset-manifest import UI.

## Phase 1 — Minimum publishable benchmark (SHIPPED v0.11.0)

Definition-of-done gate: `npm run typecheck && npm run lint && npm test && npm run build` all green, plus a manual smoke run.

1. **Local profiles / login** — `src/lib/workspace/profiles.ts`
   - create / list / switch / delete profile; optional PBKDF2 passphrase gate.
   - namespace helper `profileScope(id)` for OPFS dirs + localStorage keys.
2. **Model registry + ONNX validator** — `src/lib/registry/`
   - register a model (validate manifest via `parseManifest`, validate the ONNX
     graph: opset, declared inputs/outputs, loadability) → registry entry with
     a validation verdict; list per profile.
3. **Dataset / reference-label manifest** — `src/lib/datasets/manifest.ts`
   - case-level manifest (Assess-AI-inspired: modality, bodyPart, studyDate,
     groundTruthAvailable, referenceLabel ref) + strict parser.
4. **Metric engine (task-agnostic; segmentation wired first)** — `src/lib/metrics/`
   - `segmentation.ts`: Dice, IoU/Jaccard, precision, recall, F1, volume
     difference, volumetric similarity, HD95, ASSD (spacing-aware).
   - `classification.ts`: confusion matrix, sens/spec/PPV/NPV/accuracy/F1,
     AUROC, AUPRC, Brier, ECE (fast-follow task, engine ready now).
   - `align.ts`: reference↔prediction grid alignment via `resampleNearest`.
5. **Benchmark record + store + export** — `src/lib/benchmark/`
   - `types.ts`: `tamias.benchmark.v1` record (profile, model ref, case ref,
     metrics, runtime, timestamps).
   - `store.ts`: per-profile OPFS NDJSON append/list/delete.
   - `export.ts`: CSV + JSON export of a comparison table.
6. **Comparison UI** — `src/components/BenchmarkPanel.tsx` + `WorkspacePicker.tsx`
   - pick model(s) from registry, pick dataset + reference, run, side-by-side
     metric table, runtime, export buttons; profile switcher in the shell header.

## Phase 2 — Assess-AI-inspired evaluation layer (IMPLEMENTED, unreleased)

DICOM metadata extraction into case manifest, data-completeness dashboard
(AI result / DICOM / reference present?), concordance module (AI-vs-reference /
AI-vs-report / model-vs-model agreement), discordant-case drilldown, PDF/DOCX report export.

## Phase 3 — Multi-model & reproducibility (IMPLEMENTED, unreleased)

Cohort builder, subgroup metrics (by scanner/protocol/body part/age/sex/contrast),
browser/hardware reproducibility capture, offline privacy/network-request report.

## Phase 4 — Registry-grade governance (IMPLEMENTED, unreleased)

Versioned benchmark definitions, model cards, audit trails, reference-set locking,
optional local-network deployment.

## Metrics priority (from docx §5)

- **Segmentation (first):** Dice, IoU/Jaccard, HD95, ASSD, volume difference, volume correlation.
- **Classification (engine ready):** AUROC, AUPRC, accuracy, sensitivity, specificity, PPV, NPV, F1, Brier, ECE.
- **Platform performance:** model load time, inference time, total workflow time, provider, memory (where available), failure rate.
