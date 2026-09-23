/**
 * User-imported benchmark cases ("Import your own"): a local folder of DICOM
 * CT + DICOM-SEG files, or a CT + SEG pair of IDC series ids. Both load
 * through the same DICOM CT + SEG path as the built-in HCC-TACE-Seg cases
 * (case-loader.ts) and are scored in the canonical label space (1 liver,
 * 2 tumour) produced by the SEG segment classification.
 */
import dicomParser from 'dicom-parser';
import type { CatalogDataset, IdcCase } from './catalog';

export const IMPORTED_DATASET_ID = 'imported';

export const IMPORTED_DATASET: CatalogDataset = {
  id: IMPORTED_DATASET_ID,
  name: 'Imported cases (local DICOM / IDC series)',
  modality: 'CT',
  subjects: 0,
  license: 'as per source',
  doi: '—',
  pageUrl: 'https://portal.imaging.datacommons.cancer.gov/explore/',
  citation: 'User-imported DICOM CT + DICOM-SEG cases (cite the source collection).',
  groundTruth: ['liver', 'tumor'],
  gtLabels: { liver: [1], tumour: [2] },
  access: {
    kind: 'imported',
    note: 'DICOM CT + DICOM-SEG from a local folder or IDC series ids; SEG segments named liver / tumour (mass, lesion…) become the reference.',
  },
  description:
    'Your own CT + DICOM-SEG ground truth: a local folder, or a CT and SEG crdc_series_uuid from the IDC portal. ' +
    'Segments are mapped by name (liver → 1, tumour/mass/lesion → 2, vessels ignored).',
};

export type ImportedCase =
  | { source: 'idc'; caseId: string; description: string; idc: IdcCase }
  | {
      source: 'dicom';
      caseId: string;
      description: string;
      ctFiles: File[];
      segFile: File;
      /** Acquisition to load when the CT series holds several; undefined = pick from the SEG references. */
      acquisitionNumber?: number;
    };

/* ------------------------------------------------------------------ */
/* DICOM folder grouping                                               */
/* ------------------------------------------------------------------ */

export interface DicomHeader {
  modality: string;
  seriesUid: string;
  sopInstanceUid: string;
  patientId: string;
  seriesDescription: string;
  acquisitionNumber: number | null;
  /** SEG only: SeriesInstanceUIDs in ReferencedSeriesSequence. */
  referencedSeries: string[];
  /** SEG only: every ReferencedSOPInstanceUID anywhere in the object. */
  referencedSops: string[];
}

type PDataSet = ReturnType<typeof dicomParser.parseDicom>;

function walkReferences(ds: PDataSet, sops: string[], series: string[], inRefSeries: boolean): void {
  for (const [tag, el] of Object.entries(ds.elements)) {
    if (tag === 'x00081155') {
      const v = ds.string(tag);
      if (v) sops.push(v);
    } else if (inRefSeries && tag === 'x0020000e') {
      const v = ds.string(tag);
      if (v) series.push(v);
    }
    for (const item of el.items ?? []) {
      if (item.dataSet) walkReferences(item.dataSet, sops, series, tag === 'x00081115');
    }
  }
}

/** Header fields needed to group a folder; null for non-DICOM / unreadable files. */
export function readDicomHeader(bytes: Uint8Array): DicomHeader | null {
  let ds: PDataSet;
  try {
    ds = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' });
  } catch {
    return null;
  }
  const modality = (ds.string('x00080060') ?? '').trim().toUpperCase();
  const seriesUid = (ds.string('x0020000e') ?? '').trim();
  if (!modality || !seriesUid) return null;
  const acq = ds.string('x00200012');
  const referencedSops: string[] = [];
  const referencedSeries: string[] = [];
  if (modality === 'SEG') walkReferences(ds, referencedSops, referencedSeries, false);
  return {
    modality,
    seriesUid,
    sopInstanceUid: (ds.string('x00080018') ?? '').trim(),
    patientId: (ds.string('x00100020') ?? '').trim(),
    seriesDescription: (ds.string('x0008103e') ?? '').trim(),
    acquisitionNumber: acq === undefined || acq.trim() === '' ? null : Number(acq),
    referencedSeries,
    referencedSops,
  };
}

export interface PlannedDicomCase<F> {
  caseId: string;
  description: string;
  ctFiles: F[];
  segFile: F;
  /** Chosen acquisition (undefined when the CT has a single one). */
  acquisitionNumber?: number;
  /** All acquisitions in the CT series with how many SEG references each got. */
  acquisitions: Array<{ number: number; slices: number; segRefs: number }>;
}

/**
 * Acquisition referenced most by the SEG among the CT slices (ties → the
 * one with more slices, then the higher number). undefined if the CT holds
 * a single acquisition.
 */
export function pickAcquisition(
  ct: Array<{ sop: string; acquisition: number | null }>,
  segRefs: readonly string[]
): { chosen?: number; acquisitions: Array<{ number: number; slices: number; segRefs: number }> } {
  const refs = new Set(segRefs);
  const stats = new Map<number, { slices: number; segRefs: number }>();
  for (const s of ct) {
    if (s.acquisition === null || !Number.isFinite(s.acquisition)) continue;
    const st = stats.get(s.acquisition) ?? { slices: 0, segRefs: 0 };
    st.slices++;
    if (refs.has(s.sop)) st.segRefs++;
    stats.set(s.acquisition, st);
  }
  const acquisitions = [...stats.entries()].map(([number, v]) => ({ number, ...v })).sort((a, b) => a.number - b.number);
  if (acquisitions.length < 2) return { acquisitions };
  const best = [...acquisitions].sort((a, b) => b.segRefs - a.segRefs || b.slices - a.slices || b.number - a.number)[0]!;
  return { chosen: best.number, acquisitions };
}

/**
 * Group a picked folder into (CT series, SEG) cases — one per SEG. The CT is
 * the series the SEG's ReferencedSeriesSequence names, else the CT series
 * holding most SOPs the SEG references, else the only / largest CT series.
 */
export function planDicomCases<F>(files: Array<{ file: F; header: DicomHeader }>): PlannedDicomCase<F>[] {
  const ctSeries = new Map<string, Array<{ file: F; header: DicomHeader }>>();
  const segs: Array<{ file: F; header: DicomHeader }> = [];
  for (const f of files) {
    if (f.header.modality === 'SEG') segs.push(f);
    else if (f.header.modality === 'CT') {
      const list = ctSeries.get(f.header.seriesUid) ?? [];
      list.push(f);
      ctSeries.set(f.header.seriesUid, list);
    }
  }
  if (!segs.length) throw new Error('No DICOM-SEG object found in the selected files (Modality SEG).');
  if (!ctSeries.size) throw new Error('No CT series found in the selected files (Modality CT).');
  const used = new Map<string, number>();
  return segs.map((seg) => {
    const refs = new Set(seg.header.referencedSops);
    let uid = seg.header.referencedSeries.find((u) => ctSeries.has(u));
    if (!uid) {
      const scored = [...ctSeries.entries()]
        .map(([u, l]) => ({ u, hits: l.filter((x) => refs.has(x.header.sopInstanceUid)).length, n: l.length }))
        .sort((a, b) => b.hits - a.hits || b.n - a.n);
      if (scored[0]!.hits === 0 && ctSeries.size > 1) {
        throw new Error(`Cannot tell which CT series the SEG "${seg.header.seriesDescription || seg.header.seriesUid}" annotates (no matching references).`);
      }
      uid = scored[0]!.u;
    }
    const ct = ctSeries.get(uid)!;
    const acq = pickAcquisition(
      ct.map((x) => ({ sop: x.header.sopInstanceUid, acquisition: x.header.acquisitionNumber })),
      seg.header.referencedSops
    );
    const base = seg.header.patientId || ct[0]!.header.patientId || 'case';
    const k = (used.get(base) ?? 0) + 1;
    used.set(base, k);
    return {
      caseId: k > 1 ? `${base}#${k}` : base,
      description: `${ct[0]!.header.seriesDescription || 'CT'} + ${seg.header.seriesDescription || 'SEG'}` + (acq.chosen !== undefined ? ` · acq ${acq.chosen}` : ''),
      ctFiles: ct.map((x) => x.file),
      segFile: seg.file,
      acquisitionNumber: acq.chosen,
      acquisitions: acq.acquisitions,
    };
  });
}

/** Read headers of picked files (non-DICOM files are skipped) and plan cases. */
export async function planDicomFolder(files: File[]): Promise<PlannedDicomCase<File>[]> {
  const withHeaders: Array<{ file: File; header: DicomHeader }> = [];
  for (const file of files) {
    // Headers only: DICOM headers sit well inside the first 256 kB except for SEGs,
    // whose per-frame groups can be larger, so SEG-sized files are read whole.
    const head = new Uint8Array(await file.slice(0, 262_144).arrayBuffer());
    let header = readDicomHeader(head);
    if (header?.modality === 'SEG' || (!header && file.size > head.byteLength)) {
      header = readDicomHeader(new Uint8Array(await file.arrayBuffer()));
    }
    if (header) withHeaders.push({ file, header });
  }
  if (!withHeaders.length) throw new Error('None of the selected files is a readable DICOM object.');
  return planDicomCases(withHeaders);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a pasted IDC crdc_series_uuid pair into a case. */
export function idcImportCase(ctUuid: string, segUuid: string, label?: string): ImportedCase {
  const ct = ctUuid.trim().toLowerCase();
  const seg = segUuid.trim().toLowerCase();
  if (!UUID_RE.test(ct)) throw new Error(`CT series id "${ctUuid}" is not an IDC crdc_series_uuid (8-4-4-4-12 hex).`);
  if (!UUID_RE.test(seg)) throw new Error(`SEG series id "${segUuid}" is not an IDC crdc_series_uuid (8-4-4-4-12 hex).`);
  if (ct === seg) throw new Error('CT and SEG series ids must differ.');
  const caseId = label?.trim() || `IDC_${ct.slice(0, 8)}`;
  return {
    source: 'idc',
    caseId,
    description: `IDC CT ${ct.slice(0, 8)}… + SEG ${seg.slice(0, 8)}…`,
    idc: { caseId, patientId: caseId, ctSeriesUuid: ct, segSeriesUuid: seg },
  };
}
