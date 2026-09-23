import { describe, expect, it } from 'vitest';
import {
  idcImportCase,
  pickAcquisition,
  planDicomCases,
  planDicomFolder,
  readDicomHeader,
  IMPORTED_DATASET,
} from '../src/lib/catalog/imported-cases';
import { loadDicomCtSegCase, loadLocalDicomCase } from '../src/lib/catalog/case-loader';
import { readAcquisitionNumber } from '../src/lib/catalog/idc';
import { asBytes } from '../src/types';
import { ctSlice, segObject } from './helpers/dicom-writer';

const CT = '1.2.3.100';
const OTHER_CT = '1.2.3.200';
const SEG = '1.2.3.300';

/** Two-phase CT (acq 1 and 2 at z = 0, 1) + SEG referencing acquisition 2 (liver at z=0, tumour at z=1). */
function fixture(withRefSeries = true) {
  const slices = [1, 2].flatMap((acq) =>
    [0, 1].map((z) => ({ name: `ct_a${acq}_z${z}.dcm`, bytes: ctSlice({ series: CT, sop: `1.2.3.100.${acq}.${z}`, acquisition: acq, z }) }))
  );
  const other = { name: 'scout.dcm', bytes: ctSlice({ series: OTHER_CT, sop: '1.2.3.200.1', desc: 'SCOUT' }) };
  const seg = {
    name: 'seg.dcm',
    bytes: segObject({
      series: SEG,
      sop: '1.2.3.300.1',
      referencedSeries: withRefSeries ? CT : undefined,
      referencedSops: ['1.2.3.100.2.0', '1.2.3.100.2.1'],
      segments: [
        { number: 1, label: 'Liver' },
        { number: 2, label: 'Mass' },
        { number: 3, label: 'Portal vein' },
      ],
      frames: [
        { segment: 1, z: 0, bits: [1, 1, 1, 0] },
        { segment: 2, z: 1, bits: [0, 0, 0, 1] },
        { segment: 3, z: 1, bits: [1, 0, 0, 0] },
      ],
    }),
  };
  return { slices, other, seg };
}

describe('readDicomHeader', () => {
  it('reads CT grouping fields', () => {
    const h = readDicomHeader(ctSlice({ series: CT, sop: '9.9', acquisition: 3, patient: 'P7' }))!;
    expect(h).toMatchObject({ modality: 'CT', seriesUid: CT, sopInstanceUid: '9.9', patientId: 'P7', acquisitionNumber: 3 });
    expect(h.referencedSops).toEqual([]);
  });

  it('collects SEG references (series + every ReferencedSOPInstanceUID)', () => {
    const h = readDicomHeader(fixture().seg.bytes)!;
    expect(h.modality).toBe('SEG');
    expect(h.referencedSeries).toEqual([CT]);
    expect(new Set(h.referencedSops)).toEqual(new Set(['1.2.3.100.2.0', '1.2.3.100.2.1']));
  });

  it('returns null for non-DICOM bytes', () => {
    expect(readDicomHeader(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('pickAcquisition', () => {
  it('chooses the acquisition the SEG references most', () => {
    const ct = [
      { sop: 'a', acquisition: 1 },
      { sop: 'b', acquisition: 1 },
      { sop: 'c', acquisition: 2 },
      { sop: 'd', acquisition: 2 },
    ];
    expect(pickAcquisition(ct, ['c', 'd', 'a']).chosen).toBe(2);
    expect(pickAcquisition(ct, ['a']).acquisitions).toEqual([
      { number: 1, slices: 2, segRefs: 1 },
      { number: 2, slices: 2, segRefs: 0 },
    ]);
  });

  it('leaves single-acquisition series unfiltered', () => {
    expect(pickAcquisition([{ sop: 'a', acquisition: 1 }], ['a']).chosen).toBeUndefined();
    expect(pickAcquisition([{ sop: 'a', acquisition: null }], []).chosen).toBeUndefined();
  });
});

describe('planDicomCases', () => {
  const withHeaders = (files: Array<{ name: string; bytes: Uint8Array }>) =>
    files.map((f) => ({ file: f.name, header: readDicomHeader(f.bytes)! }));

  it('pairs the SEG with the CT series it references and picks its acquisition', () => {
    const { slices, other, seg } = fixture();
    const [c, ...rest] = planDicomCases(withHeaders([other, ...slices, seg]));
    expect(rest).toHaveLength(0);
    expect(c!.caseId).toBe('PAT1');
    expect(c!.ctFiles.sort()).toEqual(slices.map((s) => s.name).sort());
    expect(c!.segFile).toBe('seg.dcm');
    expect(c!.acquisitionNumber).toBe(2);
    expect(c!.description).toContain('acq 2');
  });

  it('falls back to SOP references when the SEG names no series', () => {
    const { slices, other, seg } = fixture(false);
    const [c] = planDicomCases(withHeaders([other, ...slices, { ...seg, bytes: seg.bytes }]));
    expect(c!.ctFiles).toHaveLength(4);
  });

  it('explains what is missing', () => {
    const { slices, seg } = fixture();
    expect(() => planDicomCases(withHeaders(slices))).toThrow(/DICOM-SEG/);
    expect(() => planDicomCases(withHeaders([seg]))).toThrow(/CT series/);
  });

  it('planDicomFolder reads File objects and skips non-DICOM files', async () => {
    const { slices, seg } = fixture();
    const files = [...slices, seg].map((f) => new File([f.bytes], f.name));
    files.push(new File(['hello'], 'README.txt'));
    const [c] = await planDicomFolder(files);
    expect(c!.ctFiles.map((f) => f.name).sort()).toEqual(slices.map((s) => s.name).sort());
    expect(c!.segFile.name).toBe('seg.dcm');
  });
});

describe('shared DICOM CT + SEG loader', () => {
  function fakeViewer() {
    const calls: string[][] = [];
    const viewer = {
      loadPrimaryFromFiles: async (items: Array<{ name: string; bytes: Uint8Array }>) => {
        calls.push(items.map((i) => i.name));
        const dims: [number, number, number] = [2, 2, 2];
        return {
          voxels: new Int16Array(8),
          meta: {
            dims,
            spacing: [1, 1, 1] as [number, number, number],
            origin: [0, 0, 0] as [number, number, number],
            // voxel (i,j,k) → RAS (-i, -j, k) ⇔ LPS (i, j, k)
            srowX: [-1, 0, 0, 0] as [number, number, number, number],
            srowY: [0, -1, 0, 0] as [number, number, number, number],
            srowZ: [0, 0, 1, 0] as [number, number, number, number],
          },
        };
      },
    };
    return { viewer: viewer as unknown as Parameters<typeof loadDicomCtSegCase>[0], calls };
  }

  it('auto-picks the SEG acquisition and maps liver / tumour, dropping vessels', async () => {
    const { slices, seg } = fixture();
    const { viewer, calls } = fakeViewer();
    const lc = await loadDicomCtSegCase(
      viewer,
      slices.map((s) => ({ name: s.name, bytes: asBytes(s.bytes) })),
      seg.bytes,
      { autoAcquisition: true }
    );
    expect(calls[0]!.sort()).toEqual(['ct_a2_z0.dcm', 'ct_a2_z1.dcm']);
    for (const n of calls[0]!) expect(n).toMatch(/_a2_/);
    // z=0: liver on 3 of 4 pixels; z=1: tumour on the last pixel, the vessel is ignored.
    expect(Array.from(lc.reference.mask)).toEqual([1, 1, 1, 0, 0, 0, 0, 2]);
    expect(lc.note).toMatch(/acquisition 2 of 1\/2/);
    expect(readAcquisitionNumber(lc.firstFile.bytes)).toBe(2);
  });

  it('an explicit acquisition wins', async () => {
    const { slices, seg } = fixture();
    const { viewer, calls } = fakeViewer();
    await loadDicomCtSegCase(viewer, slices.map((s) => ({ name: s.name, bytes: asBytes(s.bytes) })), seg.bytes, { acquisitionNumber: 1, autoAcquisition: true });
    expect(calls[0]!.every((n) => n.includes('_a1_'))).toBe(true);
  });

  it('loads a planned local folder case', async () => {
    const { slices, seg } = fixture();
    const files = [...slices, seg].map((f) => new File([f.bytes], f.name));
    const [p] = await planDicomFolder(files);
    const { viewer, calls } = fakeViewer();
    const lc = await loadLocalDicomCase(viewer, { source: 'dicom', ...p! });
    expect(calls[0]).toHaveLength(2);
    expect(lc.reference.mask[7]).toBe(2);
  });
});

describe('IDC series import', () => {
  it('validates crdc_series_uuid pairs into an IDC case', () => {
    const c = idcImportCase(' 463D9B31-b4b6-4b01-897d-209ef1770324 ', 'fdd409a9-54d8-481c-bba3-28c3833007bc');
    expect(c.source).toBe('idc');
    if (c.source !== 'idc') return;
    expect(c.caseId).toBe('IDC_463d9b31');
    expect(c.idc).toMatchObject({ ctSeriesUuid: '463d9b31-b4b6-4b01-897d-209ef1770324', segSeriesUuid: 'fdd409a9-54d8-481c-bba3-28c3833007bc' });
    expect(c.idc.acquisitionNumber).toBeUndefined();
    expect(idcImportCase('463d9b31-b4b6-4b01-897d-209ef1770324', 'fdd409a9-54d8-481c-bba3-28c3833007bc', 'HCC_099').caseId).toBe('HCC_099');
  });

  it('rejects malformed or identical ids', () => {
    expect(() => idcImportCase('1.2.3', 'fdd409a9-54d8-481c-bba3-28c3833007bc')).toThrow(/CT series id/);
    expect(() => idcImportCase('463d9b31-b4b6-4b01-897d-209ef1770324', '../x')).toThrow(/SEG series id/);
    const u = '463d9b31-b4b6-4b01-897d-209ef1770324';
    expect(() => idcImportCase(u, u)).toThrow(/differ/);
  });

  it('imported dataset scores in the canonical label space', () => {
    expect(IMPORTED_DATASET.gtLabels).toEqual({ liver: [1], tumour: [2] });
    expect(IMPORTED_DATASET.access.kind).toBe('imported');
  });
});
