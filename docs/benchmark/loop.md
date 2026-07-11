# loop.md — Iteration & Watchdog Protocol

The build runs as a TDD loop with a watchdog gate. Each unit of work cycles:

```
SPEC → RED (write failing test) → GREEN (implement) → REFACTOR → WATCHDOG → COMMIT-READY
```

## Watchdog gate (run after every unit)

```bash
npm run typecheck   # tsc -b --noEmit
npm run lint        # eslint . --max-warnings=0
npm test            # vitest run
npm run build       # tsc -b && vite build   (smoke: the app compiles)
```

A unit may not be marked DONE until the watchdog is green. If a gate fails, fix
before moving on — do not accumulate red.

## Loop order (dependency-first)

1. `lib/metrics/segmentation.ts` (+ test)      ← pure, no deps
2. `lib/metrics/classification.ts` (+ test)    ← pure, no deps
3. `lib/metrics/align.ts` (+ test)             ← depends on postprocess.resampleNearest
4. `lib/workspace/profiles.ts` (+ test)        ← localStorage + crypto.subtle
5. `lib/datasets/manifest.ts` (+ test)         ← mirrors inference/manifest.ts
6. `lib/benchmark/types.ts`                     ← record schema
7. `lib/benchmark/store.ts` (+ test)           ← OPFS NDJSON (mockable)
8. `lib/benchmark/export.ts` (+ test)          ← CSV/JSON serialization
9. `lib/registry/onnx-validate.ts` (+ test)    ← ONNX graph checks
10. `lib/registry/registry.ts` (+ test)        ← over opfs cache + profiles
11. UI: `WorkspacePicker.tsx`, `BenchmarkPanel.tsx`, store slice, AppShell wiring
12. Full watchdog + manual smoke → docs → version bump → release

## Exit criterion

All GOAL.md success criteria (G1–G7) met and the watchdog green on a clean tree.
