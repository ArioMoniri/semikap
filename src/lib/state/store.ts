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
}

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

export const useAppStore = create<AppState>((set) => ({
  backend: null,
  setBackend: (b) => set({ backend: b }),

  volume: null,
  setVolume: (v) => set({ volume: v, result: null }),

  model: null,
  setModel: (m) => set({ model: m, result: null }),

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

  sam: {
    modelLoaded: false,
    modelName: null,
    prompts: [],
    manifest: null,
    encoderBytes: null,
    decoderBytes: null,
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
}));

// ── Local-storage backed preferences ────────────────────────────────────
//
// Keep the prefs simple — current schema is just the screenshot-save mode.
// We persist to localStorage so the user's choice survives reload + the
// auto-update self-restart, but each pref is optional so missing keys
// degrade to safe defaults.

const PREFS_KEY = 'tamias.userPrefs.v1';

// Phase E.2 — rehydrate the screenshot directory handle from IDB once the
// store is set up. The store creator can't await IDB synchronously so
// we do this as a fire-and-forget IIFE that calls setPrefs when the
// stored handle resolves. If IDB is unavailable (Safari private mode,
// SSR) the handle stays null and the user re-picks via Settings.
(async () => {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const { readStoredHandle, requestHandlePermission, SCREENSHOT_DIR_KEY } =
      await import('../fs/idb-handle');
    const handle = await readStoredHandle(SCREENSHOT_DIR_KEY);
    if (!handle) return;
    // Probe permission silently — don't prompt the user yet. The first
    // screenshot capture will request permission if needed.
    const ok = await requestHandlePermission(handle).catch(() => false);
    if (!ok) return;
    useAppStore.setState((s) => ({
      prefs: { ...s.prefs, screenshotDirHandle: handle, screenshotDirName: handle.name },
    }));
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
      screenshotDirHandle: null,
    };
  } catch {
    return defaultPrefs();
  }
}

function savePrefs(p: UserPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    // Strip the live handle before serialising — it'd JSON-stringify to
    // `{}` and confuse the load path.
    const { screenshotDirHandle: _omit, ...persistable } = p;
    void _omit;
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
  };
}
