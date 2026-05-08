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
import type { SamPrompt } from '../sam/types';

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

  /** User-level UI preferences that persist across sessions. */
  prefs: UserPrefs;
  setPrefs(patch: Partial<UserPrefs>): void;
}

export interface SamState {
  /** True once an encoder + decoder ONNX have been loaded (from disk or
   *  HuggingFace cache) and verified. Drives the SamPanel UI. */
  modelLoaded: boolean;
  /** Friendly name shown when `modelLoaded` is true (e.g. "Xenova/medsam"). */
  modelName: string | null;
  /** Active prompt list — see SamPrompt for the shape. The decoder runs
   *  against the cached embedding + this list every time it changes. */
  prompts: SamPrompt[];
}

export interface UserPrefs {
  /**
   * Where canvas screenshots get saved.
   *  - 'ask': prompt for a path each time (current default behaviour)
   *  - 'auto': save to the directory in `screenshotDir` without prompting
   * The "auto" path requires File System Access API support; on
   * fallbacks the toolbar falls back to "ask" silently.
   */
  screenshotMode: 'ask' | 'auto';
  /** When `screenshotMode === 'auto'`, save to this directory handle.
   *  Stored as a serialisable name; the actual handle lives in OPFS state
   *  (we'll expand to FileSystemDirectoryHandle persistence in v0.5.8). */
  screenshotDirName: string | null;
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
  },
  setSam: (patch) => set((s) => ({ sam: { ...s.sam, ...patch } })),
  addSamPrompt: (p) =>
    set((s) => ({ sam: { ...s.sam, prompts: [...s.sam.prompts, p] } })),
  removeSamPrompt: (idx) =>
    set((s) => ({
      sam: { ...s.sam, prompts: s.sam.prompts.filter((_, i) => i !== idx) },
    })),
  clearSamPrompts: () => set((s) => ({ sam: { ...s.sam, prompts: [] } })),

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
// We persist to localStorage so the user'\''s choice survives reload + the
// auto-update self-restart, but each pref is optional so missing keys
// degrade to safe defaults.

const PREFS_KEY = 'tamias.userPrefs.v1';

function loadPrefs(): UserPrefs {
  if (typeof window === 'undefined') return defaultPrefs();
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<UserPrefs>;
    return {
      ...defaultPrefs(),
      ...parsed,
    };
  } catch {
    return defaultPrefs();
  }
}

function savePrefs(p: UserPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* quota / privacy mode — silently ignore */
  }
}

function defaultPrefs(): UserPrefs {
  return {
    screenshotMode: 'ask',
    screenshotDirName: null,
  };
}
