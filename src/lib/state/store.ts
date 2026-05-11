import { create } from 'zustand';
import type {
  BackendInfo,
  Bytes,
  ModelManifest,
  RunResult,
  SourceFormat,
  VolumeMetadata,
} from '../../types';
import type { PickedFile } from '../fs/filesystem';
import type { SamPrompt, SamManifest } from '../sam/types';

export interface VolumeRecord {
  source: PickedFile;
  /** Raw voxel data exposed by the viewer after loading. */
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  meta: VolumeMetadata;
  /** On-disk source format, derived from the file name at pick time. */
  sourceFormat: SourceFormat;
}

export interface ModelRecord {
  source: PickedFile;
  bytes: Bytes;
  hash: string;
  manifest: ModelManifest;
}

/**
 * v0.8.6 — one entry in the recent-files history. Logged each time
 * the user loads an image / model / mask, so the Settings → Files
 * browser can list them with their path (when available) and a
 * "Show in Finder" button.
 */
export interface RecentFile {
  /** Stable id (timestamp + hash). */
  id: string;
  /** What this file is — drives the Settings panel grouping. */
  kind: 'image' | 'mask' | 'model' | 'sam-model';
  /** Display name (always present) — typically the filename. */
  name: string;
  /** Absolute path when available (Tauri file picker, drag-and-drop
   *  on Tauri). Empty string in PWA mode where the browser doesn't
   *  expose absolute paths for security reasons. */
  path: string;
  /** Size in bytes — informational. */
  bytes: number;
  /** ISO timestamp when the file was loaded. */
  loadedAt: string;
}

export interface ProgressState {
  active: boolean;
  stage: string;
  fraction: number;
  message?: string;
}

export interface RunMeta {
  /** Resolved EP. */
  provider: 'webgpu' | 'webnn' | 'wasm';
  /** EPs attempted, in order. */
  attempted: string[];
  /** ISO timestamp the run started. */
  startedAt: string;
}

export interface OverlaySettings {
  opacity: number;
  colormap: 'red' | 'green' | 'blue' | 'roi_i256';
}

export interface ViewerSettings {
  /** Window centre (level), in source-image units. -1 means "auto". */
  level: number;
  /** Window width, in source-image units. -1 means "auto". */
  width: number;
}

interface AppState {
  backend: BackendInfo | null;
  setBackend(b: BackendInfo): void;

  volume: VolumeRecord | null;
  setVolume(v: VolumeRecord | null): void;

  model: ModelRecord | null;
  setModel(m: ModelRecord | null): void;

  /**
   * v0.8.6 — recent-files history. Captures every image / model /
   * mask the user has loaded this session (and across reloads via
   * localStorage), so the Settings → Files browser can list them
   * with whatever path/name we have.
   *
   * Fundamental constraint: browsers don't expose absolute paths for
   * files picked via <input type="file"> or drag-and-drop — only
   * the basename. So in PWA mode the `path` field is the basename;
   * in Tauri mode (where the Tauri file picker DOES return absolute
   * paths) the `path` is fully resolved.
   *
   * Bytes are NEVER persisted — only metadata (name, kind, size,
   * timestamp). The actual content lives in the active `volume` /
   * `model` slot until the user closes it.
   */
  recentFiles: RecentFile[];
  addRecentFile(f: RecentFile): void;
  clearRecentFiles(): void;

  result: RunResult | null;
  setResult(r: RunResult | null): void;

  runMeta: RunMeta | null;
  setRunMeta(m: RunMeta | null): void;

  overlay: OverlaySettings;
  setOverlay(o: Partial<OverlaySettings>): void;

  viewer: ViewerSettings;
  setViewer(v: Partial<ViewerSettings>): void;

  progress: ProgressState;
  setProgress(p: Partial<ProgressState>): void;

  errors: AppError[];
  pushError(message: string, opts?: { stack?: string }): void;
  clearErrors(): void;

  /**
   * Global undo stack — every reversible UI mutation worth undoing pushes
   * an entry here so a single Cmd-Z / Ctrl-Z handler can pop and revert.
   * Brush strokes are NOT in this stack — they go through NiiVue's own
   * draw history via `drawUndo()`. Capped at 50 entries (oldest dropped
   * silently) so a long session doesn't grow unbounded.
   */
  undoStack: UndoEntry[];
  pushUndo(entry: { label: string; revert: () => void }): void;
  popUndo(): UndoEntry | null;
  clearUndoStack(): void;

  /** SAM (Segment Anything) interactive-annotation state — see docs/SAM.md. */
  sam: SamState;
  setSam(patch: Partial<SamState>): void;
  addSamPrompt(p: SamPrompt): void;
  removeSamPrompt(idx: number): void;
  clearSamPrompts(): void;

  /** SAM state for Pathology mode. Independent from `sam` so loading SAM
   *  in radiology doesn't auto-load it in pathology (users may want
   *  different backbones — e.g. MedSAM on radiology, SAM 2 Tiny on
   *  pathology — or no SAM at all on one side). */
  samPathology: SamPathologyState;
  setSamPathology(patch: Partial<SamPathologyState>): void;
  addSamPathologyPrompt(p: SamPrompt): void;
  removeSamPathologyPrompt(idx: number): void;
  clearSamPathologyPrompts(): void;

  /** User-level UI preferences that persist across sessions. */
  prefs: UserPrefs;
  setPrefs(patch: Partial<UserPrefs>): void;

  /**
   * v0.7.8 — persistent measurements (distance + angle). Pre-v0.7.8
   * NiiVue's distance ruler overwrote on each new draw and the angle
   * tool only ever held one in memory. This slice stores every
   * completed measurement in mm-space so an SVG overlay can render
   * them across pan/zoom/slice changes, and the user can delete each
   * one explicitly via a click handle.
   */
  measurements: Measurement[];
  addMeasurement(m: Measurement): void;
  removeMeasurement(id: string): void;
  clearMeasurements(): void;
}

/**
 * v0.7.8 — one persistent measurement in mm space.
 * `kind: 'distance'` is a single line segment between two world-space
 * points; `kind: 'angle'` is three points (vertex, arm-1 endpoint,
 * arm-2 endpoint) that define a planar angle.
 */
export type Measurement =
  | {
      id: string;
      kind: 'distance';
      a: [number, number, number];
      b: [number, number, number];
      /** mm-space distance, computed once at add-time so the overlay
       *  doesn't have to recompute on every render. */
      distanceMm: number;
      /** ISO timestamp; used for sort order in the sidebar list. */
      addedAt: string;
    }
  | {
      id: string;
      kind: 'angle';
      vertex: [number, number, number];
      arm1: [number, number, number];
      arm2: [number, number, number];
      /** Degrees, computed once at add-time. */
      degrees: number;
      addedAt: string;
    };

export interface SamState {
  /** True once an encoder + decoder ONNX have been loaded (from disk or
   *  HuggingFace cache) and verified. Drives the SamPanel UI. */
  modelLoaded: boolean;
  /** Friendly name shown when `modelLoaded` is true (e.g. "SAM 2 Tiny"). */
  modelName: string | null;
  /** Active prompt list — see SamPrompt for the shape. The decoder runs
   *  against the cached embedding + this list every time it changes. */
  prompts: SamPrompt[];
  /** Loaded model assets — only populated when modelLoaded === true.
   *  Held in zustand alongside the rest of the SAM slice; React components
   *  rely on `modelLoaded` rather than these fields for re-render gating
   *  so the 30-360 MB ONNX bytes don't cause UI churn. */
  manifest: SamManifest | null;
  encoderBytes: Bytes | null;
  decoderBytes: Bytes | null;
  /** v0.8.0 — external-data sidecars for ONNX exports that ship as
   *  graph + weight-blob pairs (SAM 3, large multi-GB exports). Worker
   *  passes these to ORT-Web's `externalData` session option. */
  encoderExternalData: { filename: string; data: Uint8Array } | null;
  decoderExternalData: { filename: string; data: Uint8Array } | null;
  /** Cache of the most recently encoded slice, keyed by axis+index, so
   *  re-running the decoder with new prompts skips the encoder. */
  embedding: { axis: 'axial' | 'coronal' | 'sagittal'; index: number; bytes: Bytes } | null;
  /** Most recent decoder output — drives the live overlay before the user
   *  decides to commit. */
  preview: { mask: Uint8Array; width: number; height: number; score: number; sliceIndex: number } | null;
  /** Stage of the user-visible long-running task. `null` means idle. */
  busy: SamBusy | null;
}

export type SamBusy =
  | { stage: 'fetching'; label: string; bytesLoaded: number; bytesTotal?: number }
  | { stage: 'encoding'; label: string }
  | { stage: 'decoding'; label: string };

export interface SamPathologyState {
  modelLoaded: boolean;
  modelName: string | null;
  prompts: SamPrompt[];
  manifest: SamManifest | null;
  encoderBytes: Bytes | null;
  decoderBytes: Bytes | null;
  /** Cache of the most recently encoded ROI tile, keyed by ROI rect. */
  embedding:
    | { axis: 'axial' | 'coronal' | 'sagittal'; index: number; bytes: Bytes }
    | null;
  /** Decoder preview, in 1024² space (the encoded patch dims). */
  preview:
    | {
        mask: Uint8Array;
        width: number;
        height: number;
        score: number;
        sliceIndex: number;
      }
    | null;
  /** User-picked level-0 region of interest. The encoder runs on a 1024²
   *  downsample of this region; prompts are mapped from level-0 →
   *  ROI-local → 1024² inside the panel + worker. */
  roi: { x: number; y: number; width: number; height: number } | null;
  busy: SamBusy | null;
}

export interface UserPrefs {
  /**
   * Where canvas screenshots get saved.
   *  - 'ask': prompt for a path each time (current default behaviour)
   *  - 'auto': save to the directory in `screenshotDirHandle` without
   *            prompting. Requires File System Access API; falls back to
   *            'ask' silently on Safari.
   */
  screenshotMode: 'ask' | 'auto';
  /** Display name of the chosen folder — persisted to localStorage so the
   *  user sees their selection on reload even if they have to re-grant
   *  the FSA permission. */
  screenshotDirName: string | null;
  /** The actual FileSystemDirectoryHandle. NOT serialisable to JSON, so
   *  not persisted via the localStorage prefs path — survives only the
   *  current session. IDB-backed persistence ships in a follow-up. */
  screenshotDirHandle: FileSystemDirectoryHandle | null;
  /**
   * v0.7.4 — the "No upload" privacy badge in the header is dismissable.
   * Once the user clicks the X, this flag persists in localStorage so the
   * badge stays hidden across reloads. Reset via Settings → "Restore
   * privacy banner". Defaults to false (banner shown).
   */
  dismissedNoUploadBanner: boolean;
  /**
   * v0.8.0 — HuggingFace personal access token.
   *
   * Optional — only needed for **gated repos** (Meta SAM 3 mirrors,
   * research-licensed checkpoints, hospital-internal HF Spaces). Token
   * is read once at the start of `loadSamModel()` and attached as
   * `Authorization: Bearer …` ONLY on requests against `huggingface.co`
   * (not the redirected Xet/CDN hosts — those carry their own pre-signed
   * query params).
   *
   * Storage: localStorage, same path as the rest of UserPrefs.
   * Trade-off: localStorage is readable by any same-origin script — but
   * since we run with a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`)
   * and don't load any third-party JS, the only paths that could read
   * the token are paths we control. Acceptable for an MVP; OPFS-backed
   * encrypted storage is a follow-up.
   *
   * Empty string = no token set (loader sends no Authorization header).
   * The Settings UI never echoes the token back to the DOM after entry.
   */
  huggingfaceToken: string;
  /**
   * v0.8.2 — directory the user picked in Settings for model downloads.
   *
   * When set, the SAM loader writes downloaded weights (graph .onnx +
   * external-data .onnx_data sidecar) to `<dir>/sam-cache/<sha256>.bin`
   * instead of the invisible OPFS cache. The user can browse to those
   * files in Finder/Explorer, free disk space without re-launching the
   * app, copy weights between machines, etc.
   *
   * When null (default), OPFS is used — frictionless one-tap downloads
   * but invisible to the user.
   *
   * Storage parity with `screenshotDirHandle`:
   *   - The handle itself goes to IDB (FSA handles are structured-
   *     cloneable but not JSON-serialisable).
   *   - The display name goes to localStorage so the Settings panel
   *     can show "Last used: <name>" before the post-reload permission
   *     re-prompt clears.
   *   - The handle stays null on first render after reload until
   *     `requestHandlePermission()` succeeds.
   */
  modelDownloadDirHandle: FileSystemDirectoryHandle | null;
  modelDownloadDirName: string | null;
  /**
   * v0.8.4 — wheel/pinch zoom sensitivity multiplier. 1.0 = default;
   * 0.5 = half-speed; 2.0 = double-speed. Applied on top of the base
   * factor (0.003 for trackpad pinch, 0.0015 for mouse wheel).
   */
  pinchSensitivity: number;
  /**
   * v0.8.4 — flip pinch direction. False (default) = pinch-out zooms
   * in; true = pinch-out zooms out. For users with "natural" trackpad
   * scrolling reversed at the OS level or who prefer the opposite
   * mental model.
   */
  pinchInverted: boolean;
  /**
   * v0.8.5 — display unit for the distance ruler + persistent
   * distance measurements. Stored values are always mm internally
   * (NIfTI / DICOM convention); the unit only affects the SVG
   * overlay's text labels and the at-add formatting in any UI.
   *
   *   - 'mm' (default) — millimeters. Standard radiology unit.
   *   - 'cm'           — centimeters. Common for soft-tissue work
   *                      where millimeter precision is overkill.
   *   - 'px'           — pixels of the source slice. Useful when
   *                      coordinating with image-processing
   *                      pipelines that work in voxel space.
   *                      Conversion uses the source volume's voxel
   *                      spacing — the overlay grabs the spacing
   *                      from the active volume at render time.
   */
  distanceUnit: 'mm' | 'cm' | 'px';
  /**
   * v0.8.5 — paint the MPR crosshair lines in axis-matched colors
   * (X=red, Y=green, Z=blue, matching the standard radiology
   * orientation cube convention). When true, NiiVue's native
   * single-color crosshair is hidden (alpha=0) and an SVG overlay
   * paints the per-axis lines on top of each tile. When false,
   * NiiVue's native yellow-orange crosshair is used (the v0.7.x
   * behaviour). Default true.
   */
  axisColoredCrosshair: boolean;
  /**
   * v0.8.6 — per-pane crosshair lock. When true, clicking on the
   * axial pane only changes Z; coronal click only Y; sagittal click
   * only X. The other two axes stay frozen at their pre-click
   * position. Default false (NiiVue's standard 3D-crosshair-
   * everywhere behaviour). Implementation snapshots crosshairPos on
   * pointerdown + restores the OTHER two axes via microtask in
   * pointerup.
   */
  perPaneCrosshairLock: boolean;
  /**
   * v0.8.6 — calibrated screen pixels per millimeter. Used by the
   * Tools panel's "Fit 1:1 (real size)" button to set the 2D MPR
   * zoom so 1 mm in the volume ≈ 1 mm on the screen. Default 3.78
   * (the 96 DPI CSS-pixel convention); user can recalibrate by
   * measuring a known length on screen and entering the actual
   * value. Range 1..20 covers laptop retina down to typical
   * non-HiDPI desktop monitors.
   */
  pxPerMm: number;
}

/**
 * One entry in the in-app error list. `stack` is captured when available
 * (typically the original Error.stack from a worker / async catch) so users
 * without DevTools can still copy the trace from the UI.
 */
export interface AppError {
  message: string;
  stack?: string;
}

/**
 * One entry in the global undo stack. `revert()` is closure-captured at
 * push time so the producer can reverse its mutation without storing an
 * inverse delta — simpler than a command pattern and good enough for the
 * coarse-grained UI mutations we care about (slider releases, mode
 * switches). `label` is shown in tooltips / debug logs.
 */
export interface UndoEntry {
  label: string;
  revert: () => void;
  ts: number;
}

export const useAppStore = create<AppState>((set) => ({
  backend: null,
  setBackend: (b) => set({ backend: b }),

  volume: null,
  setVolume: (v) => {
    // v0.8.6 — log to recent-files history when a real volume lands.
    // Browser FSA doesn't expose absolute paths, so `path` ends up as
    // the basename hint. Tauri picker returns absolute paths in
    // future; this code is path-agnostic and will pick those up.
    if (v?.source) {
      const f: RecentFile = {
        id: `${Date.now()}-${(v.source.name ?? '?').slice(-12)}`,
        kind: 'image',
        name: v.source.name ?? '(unnamed)',
        path: v.source.hint ?? v.source.name ?? '',
        bytes: v.source.bytes?.byteLength ?? 0,
        loadedAt: new Date().toISOString(),
      };
      useAppStore.setState((s) => {
        const filtered = s.recentFiles.filter(
          (x) => !(x.kind === f.kind && x.name === f.name && x.bytes === f.bytes)
        );
        const next = [f, ...filtered].slice(0, 50);
        saveRecentFiles(next);
        return { recentFiles: next };
      });
    }
    set({ volume: v, result: null });
  },

  model: null,
  setModel: (m) => {
    if (m?.source) {
      const f: RecentFile = {
        id: `${Date.now()}-${(m.source.name ?? '?').slice(-12)}`,
        kind: 'model',
        name: m.source.name ?? '(unnamed)',
        path: m.source.hint ?? m.source.name ?? '',
        bytes: m.bytes?.byteLength ?? 0,
        loadedAt: new Date().toISOString(),
      };
      useAppStore.setState((s) => {
        const filtered = s.recentFiles.filter(
          (x) => !(x.kind === f.kind && x.name === f.name && x.bytes === f.bytes)
        );
        const next = [f, ...filtered].slice(0, 50);
        saveRecentFiles(next);
        return { recentFiles: next };
      });
    }
    set({ model: m, result: null });
  },

  /*
   * v0.8.6 — recent-files history. Initialised from localStorage on
   * load; capped at 50 entries (LRU on add). Bytes never persisted.
   */
  recentFiles: loadRecentFiles(),
  addRecentFile: (f) =>
    set((s) => {
      // Dedup by name+kind+bytes — re-loading the same file twice
      // bumps the existing entry to the top instead of duplicating.
      const filtered = s.recentFiles.filter(
        (x) => !(x.kind === f.kind && x.name === f.name && x.bytes === f.bytes)
      );
      const next = [f, ...filtered].slice(0, 50);
      saveRecentFiles(next);
      return { recentFiles: next };
    }),
  clearRecentFiles: () => {
    saveRecentFiles([]);
    return set({ recentFiles: [] });
  },

  result: null,
  setResult: (r) => set({ result: r }),

  runMeta: null,
  setRunMeta: (m) => set({ runMeta: m }),

  overlay: { opacity: 0.55, colormap: 'red' },
  setOverlay: (o) => set((s) => ({ overlay: { ...s.overlay, ...o } as OverlaySettings })),

  viewer: { level: -1, width: -1 },
  setViewer: (v) => set((s) => ({ viewer: { ...s.viewer, ...v } as ViewerSettings })),

  progress: { active: false, stage: 'idle', fraction: 0 },
  setProgress: (p) =>
    set((s) => ({ progress: { ...s.progress, ...p } as ProgressState })),

  errors: [],
  pushError: (message, opts) =>
    set((s) => ({
      errors: [
        ...s.errors.slice(-9),
        { message, ...(opts?.stack !== undefined ? { stack: opts.stack } : {}) },
      ],
    })),
  clearErrors: () => set({ errors: [] }),

  undoStack: [],
  pushUndo: (entry) =>
    set((s) => ({
      // Cap at 50 entries — older mutations drop silently. The user's
      // working memory is shorter than that anyway, and an unbounded
      // closure-holding stack would leak references to old store snapshots.
      undoStack: [...s.undoStack.slice(-49), { ...entry, ts: Date.now() }],
    })),
  popUndo: () => {
    let popped: UndoEntry | null = null;
    set((s) => {
      if (s.undoStack.length === 0) return {};
      popped = s.undoStack[s.undoStack.length - 1] ?? null;
      return { undoStack: s.undoStack.slice(0, -1) };
    });
    return popped;
  },
  clearUndoStack: () => set({ undoStack: [] }),

  sam: {
    modelLoaded: false,
    modelName: null,
    prompts: [],
    manifest: null,
    encoderBytes: null,
    decoderBytes: null,
    encoderExternalData: null,
    decoderExternalData: null,
    embedding: null,
    preview: null,
    busy: null,
  },
  setSam: (patch) => set((s) => ({ sam: { ...s.sam, ...patch } })),
  addSamPrompt: (p) =>
    set((s) => ({ sam: { ...s.sam, prompts: [...s.sam.prompts, p] } })),
  removeSamPrompt: (idx) =>
    set((s) => ({
      sam: { ...s.sam, prompts: s.sam.prompts.filter((_, i) => i !== idx) },
    })),
  clearSamPrompts: () => set((s) => ({ sam: { ...s.sam, prompts: [] } })),

  samPathology: {
    modelLoaded: false,
    modelName: null,
    prompts: [],
    manifest: null,
    encoderBytes: null,
    decoderBytes: null,
    embedding: null,
    preview: null,
    roi: null,
    busy: null,
  },
  setSamPathology: (patch) =>
    set((s) => ({ samPathology: { ...s.samPathology, ...patch } })),
  addSamPathologyPrompt: (p) =>
    set((s) => ({
      samPathology: { ...s.samPathology, prompts: [...s.samPathology.prompts, p] },
    })),
  removeSamPathologyPrompt: (idx) =>
    set((s) => ({
      samPathology: {
        ...s.samPathology,
        prompts: s.samPathology.prompts.filter((_, i) => i !== idx),
      },
    })),
  clearSamPathologyPrompts: () =>
    set((s) => ({ samPathology: { ...s.samPathology, prompts: [] } })),

  prefs: loadPrefs(),
  setPrefs: (patch) =>
    set((s) => {
      const next = { ...s.prefs, ...patch };
      savePrefs(next);
      return { prefs: next };
    }),

  // v0.7.8 — persistent measurements. Bypasses NiiVue's single-shot
  // distance ruler by storing every completed measurement in mm here;
  // the SVG overlay reads from this slice and renders them with
  // delete handles.
  measurements: [],
  addMeasurement: (m) =>
    set((s) => ({ measurements: [...s.measurements, m] })),
  removeMeasurement: (id) =>
    set((s) => ({ measurements: s.measurements.filter((m) => m.id !== id) })),
  clearMeasurements: () => set({ measurements: [] }),
}));

// ── Local-storage backed preferences ────────────────────────────────────
//
// Keep the prefs simple — current schema is just the screenshot-save mode.
// We persist to localStorage so the user's choice survives reload + the
// auto-update self-restart, but each pref is optional so missing keys
// degrade to safe defaults.

const PREFS_KEY = 'tamias.userPrefs.v1';
/** v0.8.6 — recent-files history persistence key. Bumped to v2
 *  whenever the RecentFile shape changes. */
const RECENT_KEY = 'tamias.recentFiles.v1';

function loadRecentFiles(): RecentFile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check — drop anything that doesn't look right
    // so a corrupt entry can't break the panel.
    return (parsed as Partial<RecentFile>[]).filter(
      (x): x is RecentFile =>
        typeof x?.id === 'string' &&
        typeof x?.kind === 'string' &&
        typeof x?.name === 'string' &&
        typeof x?.bytes === 'number'
    );
  } catch {
    return [];
  }
}

function saveRecentFiles(list: RecentFile[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* quota / privacy mode */
  }
}

// Phase E.2 — rehydrate the screenshot directory handle from IDB once the
// store is set up. The store creator can't await IDB synchronously so
// we do this as a fire-and-forget IIFE that calls setPrefs when the
// stored handle resolves. If IDB is unavailable (Safari private mode,
// SSR) the handle stays null and the user re-picks via Settings.
(async () => {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const {
      readStoredHandle,
      requestHandlePermission,
      SCREENSHOT_DIR_KEY,
      MODEL_DIR_KEY,
    } = await import('../fs/idb-handle');

    // Screenshot dir handle.
    const screenshotHandle = await readStoredHandle(SCREENSHOT_DIR_KEY);
    if (screenshotHandle) {
      const ok = await requestHandlePermission(screenshotHandle).catch(() => false);
      if (ok) {
        useAppStore.setState((s) => ({
          prefs: {
            ...s.prefs,
            screenshotDirHandle: screenshotHandle,
            screenshotDirName: screenshotHandle.name,
          },
        }));
      }
    }
    // v0.8.2 — model download dir handle (mirror of the screenshot path).
    const modelHandle = await readStoredHandle(MODEL_DIR_KEY);
    if (modelHandle) {
      const ok = await requestHandlePermission(modelHandle).catch(() => false);
      if (ok) {
        useAppStore.setState((s) => ({
          prefs: {
            ...s.prefs,
            modelDownloadDirHandle: modelHandle,
            modelDownloadDirName: modelHandle.name,
          },
        }));
      }
    }
  } catch {
    /* IDB read failed — falls back to user re-pick */
  }
})();

function loadPrefs(): UserPrefs {
  if (typeof window === 'undefined') return defaultPrefs();
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<UserPrefs>;
    // The dir handle never round-trips through localStorage (it's not
    // serialisable). Always restore as null; the user re-picks once per
    // session if auto-save is enabled.
    return {
      ...defaultPrefs(),
      ...parsed,
      // FSA handles never round-trip through localStorage. The IDB
      // rehydrate IIFE above patches them in once permission is granted.
      screenshotDirHandle: null,
      modelDownloadDirHandle: null,
    };
  } catch {
    return defaultPrefs();
  }
}

function savePrefs(p: UserPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    // Strip the live handles before serialising — they'd JSON-stringify
    // to `{}` and confuse the load path. The display-name companions
    // (`screenshotDirName`, `modelDownloadDirName`) DO persist so the
    // Settings panel can show "Last used: …" before the post-reload
    // permission re-prompt clears.
    const {
      screenshotDirHandle: _o1,
      modelDownloadDirHandle: _o2,
      ...persistable
    } = p;
    void _o1;
    void _o2;
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(persistable));
  } catch {
    /* quota / privacy mode — silently ignore */
  }
}

function defaultPrefs(): UserPrefs {
  return {
    screenshotMode: 'ask',
    screenshotDirName: null,
    screenshotDirHandle: null,
    modelDownloadDirHandle: null,
    modelDownloadDirName: null,
    dismissedNoUploadBanner: false,
    huggingfaceToken: '',
    pinchSensitivity: 1,
    pinchInverted: false,
    distanceUnit: 'mm',
    axisColoredCrosshair: true,
    perPaneCrosshairLock: false,
    pxPerMm: 3.78,
  };
}
