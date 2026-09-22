/**
 * Small, self-contained state store for the benchmarking feature. Kept separate
 * from the main 1000-line app store so the feature is isolated and the main
 * store stays focused on viewer/inference concerns.
 *
 * Holds:
 *  - the active local profile id (the "logged-in" user),
 *  - a captured reference snapshot (ground-truth or a prior model output) to
 *    score subsequent runs against,
 *  - the loaded benchmark records for the active profile,
 *  - a tick counter to nudge components to re-read localStorage-backed lists
 *    (profiles / registry) after a mutation.
 */

import { create } from 'zustand';
import type { BenchmarkRecord } from '../benchmark/types';
import { ensureLocalDefaultProfile } from '../workspace/profiles';

export interface ReferenceSnapshot {
  /** Where the reference came from. */
  source: 'result' | 'volume';
  /** Human label (e.g. file name or "Model A output"). */
  label: string;
  /** Label mask (0 = background). */
  mask: Uint8Array;
  dims: [number, number, number];
  spacing: [number, number, number];
  /**
   * Catalogue ground truth: canonical liver/tumour label space (1 liver,
   * 2 tumour) + provenance, so predictions are mapped from the model's own
   * labels and records are grouped per dataset/case.
   */
  catalog?: { datasetId: string; caseId: string; labelSpace: 'liver-tumour' };
}

interface BenchmarkState {
  currentProfileId: string | null;
  setCurrentProfile(id: string | null): void;

  reference: ReferenceSnapshot | null;
  setReference(r: ReferenceSnapshot | null): void;

  records: BenchmarkRecord[];
  setRecords(r: BenchmarkRecord[]): void;
  addRecord(r: BenchmarkRecord): void;

  /** Bump to force profile/registry-backed components to re-read storage. */
  tick: number;
  bump(): void;
}

export const useBenchmarkStore = create<BenchmarkState>((set) => ({
  currentProfileId: ensureLocalDefaultProfile(),
  setCurrentProfile: (id) => set({ currentProfileId: id, reference: null }),

  reference: null,
  setReference: (r) => set({ reference: r }),

  records: [],
  setRecords: (r) => set({ records: r }),
  addRecord: (r) => set((s) => ({ records: [...s.records, r] })),

  tick: 0,
  bump: () => set((s) => ({ tick: s.tick + 1 })),
}));
