import { create } from 'zustand';
import type { BackendInfo, Bytes, ModelManifest, RunResult, VolumeMetadata } from '../../types';
import type { PickedFile } from '../fs/filesystem';

export interface VolumeRecord {
  source: PickedFile;
  /** Raw voxel data exposed by the viewer after loading. */
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  meta: VolumeMetadata;
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

interface AppState {
  backend: BackendInfo | null;
  setBackend(b: BackendInfo): void;

  volume: VolumeRecord | null;
  setVolume(v: VolumeRecord | null): void;

  model: ModelRecord | null;
  setModel(m: ModelRecord | null): void;

  result: RunResult | null;
  setResult(r: RunResult | null): void;

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

  progress: { active: false, stage: 'idle', fraction: 0 },
  setProgress: (p) =>
    set((s) => ({ progress: { ...s.progress, ...p } as ProgressState })),

  errors: [],
  pushError: (message) =>
    set((s) => ({ errors: [...s.errors.slice(-9), message] })),
  clearErrors: () => set({ errors: [] }),
}));
