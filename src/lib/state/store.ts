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

  errors: string[];
  pushError(message: string): void;
  clearErrors(): void;
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
  pushError: (message) =>
    set((s) => ({ errors: [...s.errors.slice(-9), message] })),
  clearErrors: () => set({ errors: [] }),
}));
