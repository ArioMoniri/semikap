/**
 * Catalogue → "Import your own": a Zenodo model record, a local DICOM CT +
 * DICOM-SEG folder, or an IDC CT + SEG series pair. Imported models join the
 * catalogue model list (Load / Batch); imported cases form the "Imported
 * cases" dataset (Load CT + GT / Batch).
 */
import { useRef, useState } from 'react';
import { Loader2, Import, FolderOpen, Cloud } from 'lucide-react';
import type { CatalogModel, ModelIndex } from '../lib/catalog/catalog';
import { fetchCatalogAsset, CatalogCorsError } from '../lib/catalog/fetch';
import {
  parseZenodoRef,
  parseZenodoRecord,
  resolveZenodoFiles,
  zenodoRecordApiUrl,
  catalogModelFromResolution,
  formatParity,
  type ZenodoRecord,
  type ZenodoResolution,
} from '../lib/catalog/zenodo';
import { IMPORTED_DATASET_ID, idcImportCase, planDicomFolder, type ImportedCase } from '../lib/catalog/imported-cases';
import { useCatalogStore } from '../lib/state/catalogStore';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { ExternalLink } from './ExternalLink';

interface Props {
  index: ModelIndex | null;
  disabled: boolean;
}

function mb(n: number): string {
  return n ? `${(n / 1e6).toFixed(n > 1e7 ? 0 : 1)} MB` : '';
}

const inputCls =
  'min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900';

export function CatalogImportPanel({ index, disabled }: Props) {
  const models = useCatalogStore((s) => s.models);
  const addImportedModels = useCatalogStore((s) => s.addImportedModels);
  const addImportedCases = useCatalogStore((s) => s.addImportedCases);
  const setDatasetId = useCatalogStore((s) => s.setDatasetId);
  const selectedModels = useCatalogStore((s) => s.selectedModels);
  const setSelectedModels = useCatalogStore((s) => s.setSelectedModels);
  const selectedCases = useCatalogStore((s) => s.selectedCases);
  const setSelectedCases = useCatalogStore((s) => s.setSelectedCases);

  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [record, setRecord] = useState<ZenodoRecord | null>(null);
  const [resolved, setResolved] = useState<ZenodoResolution[]>([]);
  const [ctUuid, setCtUuid] = useState('');
  const [segUuid, setSegUuid] = useState('');
  const [idcLabel, setIdcLabel] = useState('');
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const start = (what: string) => {
    setBusy(what);
    setError(null);
    setNotice(null);
  };

  async function onZenodo() {
    const id = parseZenodoRef(ref);
    if (!id) {
      setError('Enter a Zenodo record id (e.g. 11582728), DOI (10.5281/zenodo.11582728) or zenodo.org record URL.');
      return;
    }
    start('zenodo');
    setRecord(null);
    setResolved([]);
    const url = zenodoRecordApiUrl(id);
    try {
      const bytes = await fetchCatalogAsset(url);
      const rec = parseZenodoRecord(JSON.parse(new TextDecoder().decode(bytes)));
      setRecord(rec);
      setResolved(resolveZenodoFiles(rec, index, models));
    } catch (e) {
      setError(
        e instanceof CatalogCorsError
          ? `This browser could not read ${url} (blocked by CORS or offline). Use the TAMIAS desktop app, which fetches Zenodo natively.`
          : (e as Error).message
      );
    } finally {
      setBusy(null);
    }
  }

  function addModel(r: ZenodoResolution) {
    if (!record) return;
    const m = catalogModelFromResolution(record, r);
    if (!m) return;
    addImportedModels([m]);
    if (!selectedModels.includes(m.id)) setSelectedModels([...selectedModels, m.id]);
    setNotice(`${m.name} is in the model list and selected for Batch — press Load to run it now.`);
  }

  function addCases(cases: ImportedCase[]) {
    addImportedCases(cases);
    // The store may suffix duplicate ids; read back what was added.
    const added = useCatalogStore.getState().importedCases.slice(-cases.length).map((c) => c.caseId);
    setDatasetId(IMPORTED_DATASET_ID);
    setSelectedCases([...new Set([...selectedCases, ...added])]);
    return added;
  }

  async function onDicom(files: File[]) {
    if (!files.length) return;
    start('dicom');
    try {
      const planned = await planDicomFolder(files);
      const added = addCases(planned.map((p) => ({ source: 'dicom' as const, ...p })));
      const multi = planned.filter((p) => p.acquisitions.length > 1);
      setNotice(
        `Imported ${added.length} case(s): ${added.join(', ')}.` +
          (multi.length
            ? ` Multi-phase CT: using the acquisition the SEG references most (${multi.map((p) => `${p.caseId} → ${p.acquisitionNumber}`).join(', ')}).`
            : '') +
          ' Select "Imported cases" to load or batch them.'
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function onIdc() {
    setError(null);
    setNotice(null);
    try {
      const added = addCases([idcImportCase(ctUuid, segUuid, idcLabel)]);
      setNotice(`Added IDC case ${added[0]}. It downloads from the IDC public bucket on Load CT + GT or in Batch.`);
      setCtUuid('');
      setSegUuid('');
      setIdcLabel('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const listed = (m: CatalogModel | null) => !!m && models.some((x) => x.id === m.id);

  return (
    <section className="space-y-2 rounded border border-slate-200 p-2 dark:border-slate-700" data-testid="catalog-import">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Import className="h-3.5 w-3.5" /> Import your own
      </div>

      {/* ---------------- Zenodo ---------------- */}
      <div className="space-y-1">
        <label htmlFor="zenodo-import-input" className="block text-[11px] font-medium">
          Zenodo model record (id, DOI or URL)
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="zenodo-import-input"
            data-testid="zenodo-import-input"
            value={ref}
            onChange={(e) => setRef(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && busy === null) void onZenodo();
            }}
            placeholder="10.5281/zenodo.11582728"
            className={inputCls}
          />
          <Button size="sm" data-testid="zenodo-import-button" onClick={() => void onZenodo()} disabled={busy !== null || disabled || !ref.trim()} className="gap-1">
            {busy === 'zenodo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
            Import
          </Button>
        </div>
        <p className="text-[10px] leading-tight text-slate-500">
          ONNX + TAMIAS manifest in the record load directly. A PyTorch / nnU-Net checkpoint whose md5 matches a published conversion
          gets that checkpoint's full-precision fp32 ONNX export (parity-checked vs PyTorch). Anything else shows the exact conversion
          command — no demo or placeholder model is ever substituted.
        </p>
        {record && (
          <div className="space-y-1 rounded bg-slate-50 p-1.5 dark:bg-slate-900" data-testid="zenodo-import-result">
            <div className="text-[11px] font-medium">
              <ExternalLink className="underline" href={`https://zenodo.org/records/${record.id}`}>
                {record.title}
              </ExternalLink>
            </div>
            <div className="text-[10px] text-slate-500">
              doi:{record.doi} · {record.license || 'licence not stated'} · {record.creators.slice(0, 3).join(', ')}
              {record.creators.length > 3 ? ' et al.' : ''}
            </div>
            <ul className="space-y-1">
              {resolved
                .filter((r) => r.kind !== 'auxiliary')
                .map((r) => {
                  const m = catalogModelFromResolution(record, r);
                  return (
                    <li key={r.file.key} className="rounded border border-slate-200 px-1.5 py-1 text-[10px] dark:border-slate-700">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium" title={r.file.key}>
                          {r.file.key} <span className="font-normal text-slate-400">{mb(r.file.size)}</span>
                        </span>
                        {r.kind === 'onnx' && <Badge variant="ok" className="text-[10px]">ONNX + manifest</Badge>}
                        {r.kind === 'verified-conversion' && <Badge variant="ok" className="text-[10px]">verified fp32 export</Badge>}
                        {r.kind === 'needs-conversion' && <Badge variant="warn" className="text-[10px]">needs conversion</Badge>}
                        {m && (
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => addModel(r)} disabled={disabled}>
                            {listed(m) ? 'Select' : 'Add'}
                          </Button>
                        )}
                      </div>
                      {r.kind === 'verified-conversion' && (
                        <div className="text-slate-500">
                          → {r.model.name}: converted from {r.file.key}, md5 match ({r.source.sourceMd5}), {formatParity(r.parity)}
                        </div>
                      )}
                      {r.kind === 'onnx' && <div className="text-slate-500">loads {r.file.key} with manifest {r.manifest.key}</div>}
                      {r.kind === 'needs-conversion' && (
                        <>
                          <div className="text-slate-500">{r.reason}</div>
                          <code className="mt-0.5 block select-all whitespace-pre-wrap break-all rounded bg-slate-100 p-1 font-mono text-[9px] dark:bg-slate-800">
                            {r.command}
                          </code>
                        </>
                      )}
                    </li>
                  );
                })}
            </ul>
            {resolved.some((r) => r.kind === 'auxiliary') && (
              <div className="text-[10px] text-slate-400">
                Other files: {resolved.filter((r) => r.kind === 'auxiliary').map((r) => r.file.key).join(', ')}
              </div>
            )}
            {!resolved.some((r) => r.kind !== 'auxiliary') && <div className="text-[10px] text-slate-500">No model files in this record.</div>}
          </div>
        )}
      </div>

      {/* ---------------- Local DICOM ---------------- */}
      <div className="space-y-1">
        <div className="text-[11px] font-medium">Local DICOM CT + DICOM-SEG</div>
        <input
          ref={filesRef}
          id="dicom-import-input"
          data-testid="dicom-import-input"
          aria-label="DICOM CT and DICOM-SEG files"
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = '';
            void onDicom(files);
          }}
        />
        <input
          ref={folderRef}
          aria-label="DICOM folder"
          type="file"
          multiple
          className="hidden"
          {...({ webkitdirectory: '' } as Record<string, string>)}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = '';
            void onDicom(files);
          }}
        />
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => folderRef.current?.click()} disabled={busy !== null || disabled}>
            {busy === 'dicom' ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />} Folder
          </Button>
          <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => filesRef.current?.click()} disabled={busy !== null || disabled}>
            <FolderOpen className="h-3 w-3" /> Files
          </Button>
        </div>
        <p className="text-[10px] leading-tight text-slate-500">
          Grouped by series: one case per SEG, on the CT series it references. Multi-phase CT keeps the acquisition the SEG references most.
        </p>
      </div>

      {/* ---------------- IDC series ---------------- */}
      <div className="space-y-1">
        <div className="text-[11px] font-medium">IDC series (crdc_series_uuid from the IDC portal)</div>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-1.5 gap-y-1 text-[10px]">
          <label htmlFor="idc-import-ct">CT</label>
          <input id="idc-import-ct" data-testid="idc-import-ct" value={ctUuid} onChange={(e) => setCtUuid(e.currentTarget.value)} placeholder="463d9b31-b4b6-4b01-897d-209ef1770324" className={inputCls} />
          <label htmlFor="idc-import-seg">SEG</label>
          <input id="idc-import-seg" data-testid="idc-import-seg" value={segUuid} onChange={(e) => setSegUuid(e.currentTarget.value)} placeholder="fdd409a9-54d8-481c-bba3-28c3833007bc" className={inputCls} />
          <label htmlFor="idc-import-label">Name</label>
          <input id="idc-import-label" value={idcLabel} onChange={(e) => setIdcLabel(e.currentTarget.value)} placeholder="optional case id" className={inputCls} />
        </div>
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" data-testid="idc-import-button" onClick={onIdc} disabled={disabled || !ctUuid.trim() || !segUuid.trim()}>
          Add IDC case
        </Button>
      </div>

      {notice && <div className="rounded bg-emerald-50 p-2 text-[11px] text-emerald-800">{notice}</div>}
      {error && <div className="whitespace-pre-wrap rounded bg-red-50 p-2 text-[11px] text-red-700" role="alert">{error}</div>}
    </section>
  );
}
