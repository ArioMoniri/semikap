/**
 * Catalogue UI state shared by the Catalogue panel, the Examples panel's
 * benchmark kits, the batch runner and the mask-comparison grid.
 */
import { create } from 'zustand';
import { CATALOG_DATASETS, CATALOG_MODELS, type CatalogModel } from '../catalog/catalog';
import type { BenchmarkKit } from '../catalog/kits';
import type { KeySlice, KeySlicePrediction } from '../benchmark/mask-compare';

export interface CatalogState {
  models: CatalogModel[];
  setModels(m: CatalogModel[]): void;
  datasetId: string;
  setDatasetId(id: string): void;
  selectedCases: string[];
  setSelectedCases(ids: string[]): void;
  selectedModels: string[];
  setSelectedModels(ids: string[]): void;
  /** Controlled open state of the sidebar Catalogue section. */
  sectionOpen: boolean;
  setSectionOpen(open: boolean): void;
  /** Bumped when a kit is opened so the panel can scroll into view. */
  kitNonce: number;
  activeKit: string | null;
  openKit(kit: BenchmarkKit): void;
  /** Mask comparison: one key slice per case (dataset/case). */
  keySlices: Record<string, KeySlice>;
  putKeySlice(base: Omit<KeySlice, 'preds'>, pred?: KeySlicePrediction): void;
  clearKeySlices(): void;
  /** A catalogue batch benchmark is running (single-model / single-case loads are disabled). */
  batchRunning: boolean;
  setBatchRunning(running: boolean): void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  models: [...CATALOG_MODELS],
  setModels: (models) => set({ models }),
  datasetId: CATALOG_DATASETS[0]!.id,
  setDatasetId: (datasetId) => set({ datasetId }),
  selectedCases: [],
  setSelectedCases: (selectedCases) => set({ selectedCases }),
  selectedModels: [],
  setSelectedModels: (selectedModels) => set({ selectedModels }),
  sectionOpen: false,
  setSectionOpen: (sectionOpen) => set({ sectionOpen }),
  kitNonce: 0,
  activeKit: null,
  openKit: (kit) =>
    set((s) => ({
      datasetId: kit.datasetId,
      selectedCases: kit.caseIds ?? [],
      selectedModels: kit.modelIds,
      sectionOpen: true,
      activeKit: kit.id,
      kitNonce: s.kitNonce + 1,
    })),
  keySlices: {},
  putKeySlice: (base, pred) =>
    set((s) => {
      const prev = s.keySlices[base.caseKey];
      const keep = prev && prev.z === base.z && prev.width === base.width ? prev.preds : [];
      const preds = pred ? [...keep.filter((p) => p.model !== pred.model), pred] : keep;
      return { keySlices: { ...s.keySlices, [base.caseKey]: { ...base, preds } } };
    }),
  clearKeySlices: () => set({ keySlices: {} }),
  batchRunning: false,
  setBatchRunning: (batchRunning) => set({ batchRunning }),
}));
