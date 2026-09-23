/**
 * Catalogue UI state shared by the Catalogue panel, the Examples panel's
 * benchmark kits, the batch runner and the mask-comparison grid.
 */
import { create } from 'zustand';
import { CATALOG_DATASETS, CATALOG_MODELS, type CatalogModel } from '../catalog/catalog';
import type { BenchmarkKit } from '../catalog/kits';
import type { ImportedCase } from '../catalog/imported-cases';
import type { KeySlice, KeySlicePrediction } from '../benchmark/mask-compare';

export interface CatalogState {
  /** Built-in catalogue models (release index merged) followed by user imports. */
  models: CatalogModel[];
  /** Replace the built-in models; imported ones are kept. */
  setModels(m: CatalogModel[]): void;
  /** Add models imported from a Zenodo record (no-op for ids already listed). */
  addImportedModels(m: CatalogModel[]): void;
  removeImportedModel(id: string): void;
  /** Cases of the "Imported cases" dataset (local DICOM folders, IDC series ids). */
  importedCases: ImportedCase[];
  addImportedCases(c: ImportedCase[]): void;
  removeImportedCase(caseId: string): void;
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

const IMPORTED_KEY = 'tamias.catalog.imported-models.v1';

/** Imported model entries survive reloads (metadata only; bytes live in the OPFS cache). */
function readImported(): CatalogModel[] {
  try {
    const raw = JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? (raw as CatalogModel[]).filter((m) => m && typeof m.id === 'string' && m.imported) : [];
  } catch {
    return [];
  }
}

function writeImported(models: CatalogModel[]): void {
  try {
    localStorage.setItem(IMPORTED_KEY, JSON.stringify(models.filter((m) => m.imported)));
  } catch {
    /* storage unavailable: imports last for this session */
  }
}

export const useCatalogStore = create<CatalogState>((set) => ({
  models: [...CATALOG_MODELS, ...readImported().filter((m) => !CATALOG_MODELS.some((b) => b.id === m.id))],
  setModels: (models) => set((s) => ({ models: [...models, ...s.models.filter((m) => m.imported && !models.some((b) => b.id === m.id))] })),
  addImportedModels: (add) =>
    set((s) => {
      const fresh = add.filter((m, i) => !s.models.some((x) => x.id === m.id) && add.findIndex((y) => y.id === m.id) === i);
      if (!fresh.length) return {};
      const models = [...s.models, ...fresh];
      writeImported(models);
      return { models };
    }),
  removeImportedModel: (id) =>
    set((s) => {
      const models = s.models.filter((m) => !(m.imported && m.id === id));
      writeImported(models);
      return { models, selectedModels: s.selectedModels.filter((x) => x !== id) };
    }),
  importedCases: [],
  addImportedCases: (add) =>
    set((s) => {
      const ids = new Set(s.importedCases.map((c) => c.caseId));
      const cases = add.map((c) => {
        let id = c.caseId;
        for (let k = 2; ids.has(id); k++) id = `${c.caseId}#${k}`;
        ids.add(id);
        return id === c.caseId ? c : ({ ...c, caseId: id } as ImportedCase);
      });
      return { importedCases: [...s.importedCases, ...cases] };
    }),
  removeImportedCase: (caseId) =>
    set((s) => ({
      importedCases: s.importedCases.filter((c) => c.caseId !== caseId),
      selectedCases: s.selectedCases.filter((x) => x !== caseId),
    })),
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
