# /goal — Radiology Benchmarking Phase 1

## Goal statement

Ship a per-user, local, privacy-preserving radiology benchmarking capability in
TAMIAS: a user logs into a local profile, registers ONNX models, runs them on
their own imaging + reference labels, and sees a standardized, exportable metric
comparison — with **zero upload** and **no backend**.

## Success criteria (measurable)

- G1. A user can create/switch/delete a local profile; each profile's models,
  datasets, and benchmark runs are isolated from other profiles.
- G2. A user can register an ONNX model; invalid manifests/graphs are rejected
  with a precise reason; valid ones get a validation verdict.
- G3. Given a prediction mask and a reference mask, the engine returns Dice,
  IoU, precision, recall, F1, HD95, ASSD, and volume difference — spacing-aware
  and grid-aligned.
- G4. Classification metrics (AUROC/AUPRC/sens/spec/PPV/NPV/F1/Brier/ECE) are
  available from the same engine.
- G5. A benchmark run is persisted as a `tamias.benchmark.v1` record and can be
  exported as CSV and JSON.
- G6. The Benchmark panel shows a side-by-side model comparison table + runtime,
  reachable from the radiology shell, gated by the active profile.
- G7. `typecheck + lint + test + build` all green; manual smoke passes; README +
  CHANGELOG updated; version bumped; release cut.

## Definition of Done (per unit)

A unit is DONE only when ALL hold:

1. **Tested** — vitest unit tests exist and pass (pure logic covered incl. edge
   cases: empty masks, mismatched grids, single-class, ties).
2. **Typed** — `npm run typecheck` passes; no `any` leaks in public signatures.
3. **Lint-clean** — `npm run lint` passes (max-warnings=0).
4. **Privacy-safe** — no PHI bytes persisted; only names + hashes + metrics.
5. **Integrated** — reachable from the UI or exported by a public function; not
   dead code.
6. **Documented** — public functions have a docstring stating the contract.

## Non-goals (Phase 1)

- No cloud accounts, sync, or public leaderboard.
- No DICOM-SEG/RTSTRUCT reference import (Phase 2) — Phase 1 accepts NIfTI/NRRD
  masks + label arrays already loadable by the viewer, and CSV/array labels for
  classification.
- No PDF/DOCX report export (Phase 2).
