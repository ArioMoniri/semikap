import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cloud, Search, Download, Loader2, Trash2, ChevronRight, ChevronDown } from 'lucide-react';
import {
  searchStudies,
  listSeries,
  downloadSeries,
  pingProxy,
  getCacheUsage,
  clearCache,
  type IdcStudy,
  type IdcSeries,
} from '../lib/idc/dicomweb';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import type { ViewerHandle } from './Viewer';
import { asBytes, detectSourceFormat } from '../types';

/**
 * v0.9.0 — IDC (Imaging Data Commons) browser panel.
 *
 * Talks to the public IDC DICOMweb proxy (no auth, no Pyodide, no backend)
 * to give the radiology tab a "search and download a public cancer-imaging
 * dataset" affordance. Workflow:
 *   1. User picks filters (PatientID, modality, date, free-text desc).
 *   2. searchStudies() runs QIDO-RS — returns up to `limit` matching
 *      studies, each with their series count + modality list.
 *   3. User expands a study → listSeries() runs (one round-trip per click).
 *   4. User picks a series → downloadSeries() pulls every instance with
 *      6-way concurrency, caches them in OPFS, and hands them to NiiVue's
 *      existing multi-DICOM loader (loadPrimaryFromFiles) — same code
 *      path as a local series drag-drop.
 *
 * Privacy model: every query + download hits ONE host (the IDC public
 * proxy). The host is allowlisted in the strict CSP. We don't send any
 * cookies, identifiers, or telemetry — these are read-only public data
 * requests. The "no upload" promise of the app is preserved: nothing
 * the user picks/loads ever leaves the device, and IDC downloads are
 * one-way INTO the device.
 */
export function IdcBrowser({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const setVolume = useAppStore((s) => s.setVolume);
  const pushError = useAppStore((s) => s.pushError);
  const [open, setOpen] = useState(false);
  const [proxyOk, setProxyOk] = useState<boolean | null>(null);
  const [cacheUsage, setCacheUsage] = useState<{ bytes: number; series: number }>({
    bytes: 0,
    series: 0,
  });

  // Filter state — kept simple. Power users can use the IDC web portal.
  const [patientId, setPatientId] = useState('');
  const [modality, setModality] = useState('');
  const [studyDescription, setStudyDescription] = useState('');
  const [studyDate, setStudyDate] = useState('');

  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<IdcStudy[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Per-study expansion + series load. `expanded` is a Set keyed by
  // StudyInstanceUID so expanding multiple studies in parallel works.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seriesByStudy, setSeriesByStudy] = useState<Record<string, IdcSeries[]>>({});

  const [downloading, setDownloading] = useState<string | null>(null); // SeriesUID
  const [progress, setProgress] = useState<{ loaded: number; total: number; mb: number } | null>(
    null
  );

  // Re-check proxy + cache usage when the panel opens. Cheap calls (HEAD
  // ping + OPFS dir-walk) so doing them on each open keeps the UI honest
  // about whether downloads will work and how much disk is in use.
  useEffect(() => {
    if (!open) return;
    void pingProxy().then(setProxyOk);
    void getCacheUsage().then(setCacheUsage);
  }, [open]);

  const handleSearch = useCallback(async () => {
    setSearching(true);
    setError(null);
    setResults([]);
    setExpanded(new Set());
    setSeriesByStudy({});
    try {
      // v0.9.9 — when StudyDescription is set we post-filter the
      // results on the client (the IDC proxy doesn't accept that filter
      // server-side). With the default limit=50 the client-side filter
      // would frequently return 0 even when matches existed deeper in
      // the result set. Bump the server-side cap to 500 specifically
      // for that path so the description filter actually narrows from
      // a useful sample. Plain searches (no description) keep limit=50.
      const wantsClientFilter = Boolean(studyDescription.trim());
      const studies = await searchStudies({
        ...(patientId && { PatientID: patientId.trim() }),
        ...(modality && { ModalitiesInStudy: modality.trim() }),
        ...(studyDescription && { StudyDescription: studyDescription.trim() }),
        ...(studyDate && { StudyDate: normalizeStudyDate(studyDate) }),
        limit: wantsClientFilter ? 500 : 50,
      });
      setResults(studies);
      if (studies.length === 0) {
        setError(
          wantsClientFilter
            ? `No studies match — the IDC proxy doesn't filter on Study description server-side, so we scanned the first 500 results post-filtering against "${studyDescription.trim()}". Try a different keyword, combine with a Modality or date, or omit the description and browse.`
            : 'No studies match those filters. Try removing one (e.g. Patient ID) or widening the date range.'
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }, [patientId, modality, studyDescription, studyDate]);

  const toggleStudy = useCallback(
    async (study: IdcStudy) => {
      const next = new Set(expanded);
      if (next.has(study.StudyInstanceUID)) {
        next.delete(study.StudyInstanceUID);
        setExpanded(next);
        return;
      }
      next.add(study.StudyInstanceUID);
      setExpanded(next);
      // Lazy-load series on first expand. Subsequent toggles reuse the
      // cached list so the user can collapse + re-expand without
      // re-roundtripping.
      if (!seriesByStudy[study.StudyInstanceUID]) {
        try {
          const series = await listSeries(study.StudyInstanceUID);
          setSeriesByStudy((m) => ({ ...m, [study.StudyInstanceUID]: series }));
        } catch (e) {
          setError(`Series list failed: ${(e as Error).message}`);
        }
      }
    },
    [expanded, seriesByStudy]
  );

  const handleDownload = useCallback(
    async (series: IdcSeries) => {
      if (!viewerRef.current) {
        pushError('Viewer not ready — wait a moment and try again.');
        return;
      }
      setDownloading(series.SeriesInstanceUID);
      setProgress({ loaded: 0, total: series.NumberOfInstances || 1, mb: 0 });
      try {
        const instances = await downloadSeries(
          series.StudyInstanceUID,
          series.SeriesInstanceUID,
          (p) =>
            setProgress({
              loaded: p.loaded,
              total: p.total,
              mb: p.bytesLoaded / (1024 * 1024),
            })
        );
        if (instances.length === 0) {
          throw new Error('Series returned 0 instances from the proxy.');
        }
        // Hand off to the SAME loadPrimaryFromFiles path used by local
        // multi-DICOM drag-drop — NiiVue sorts by ImagePositionPatient
        // and produces a single 3D volume.
        const items = instances.map((i) => ({ name: i.name, bytes: asBytes(i.bytes) }));
        const loaded = await viewerRef.current.loadPrimaryFromFiles(items);
        const first = items[0]!;
        setVolume({
          source: {
            name: `${series.SeriesDescription || series.Modality || 'IDC series'} (${series.NumberOfInstances})`,
            bytes: first.bytes,
            hint: `idc://${series.StudyInstanceUID}/${series.SeriesInstanceUID}`,
          },
          voxels: loaded.voxels,
          meta: loaded.meta,
          sourceFormat: detectSourceFormat(first.name),
        });
        // Refresh the cache-size pill so the user sees the new bytes
        // landed on disk.
        void getCacheUsage().then(setCacheUsage);
        // Auto-collapse the panel so the viewer is unobstructed.
        setOpen(false);
      } catch (e) {
        pushError(`IDC download failed: ${(e as Error).message}`);
      } finally {
        setDownloading(null);
        setProgress(null);
      }
    },
    [viewerRef, setVolume, pushError]
  );

  const handleClearCache = useCallback(async () => {
    await clearCache();
    setCacheUsage({ bytes: 0, series: 0 });
  }, []);

  const cacheLabel = useMemo(() => {
    if (cacheUsage.series === 0) return 'cache empty';
    const mb = cacheUsage.bytes / (1024 * 1024);
    return mb >= 1024
      ? `${(mb / 1024).toFixed(1)} GB · ${cacheUsage.series} series`
      : `${mb.toFixed(0)} MB · ${cacheUsage.series} series`;
  }, [cacheUsage]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-tamias-accent" /> IDC + TCIA public data
          </CardTitle>
          <CardDescription>
            NCI Imaging Data Commons (mirrors every TCIA collection + extras) — search + download. No login needed.
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {proxyOk === false && <Badge variant="warn">offline</Badge>}
          {proxyOk === true && <Badge variant="ok">online</Badge>}
          <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Browse'}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="space-y-0.5">
              <span className="text-slate-500">Patient ID</span>
              <input
                type="text"
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                placeholder="e.g. TCGA-CC-A8KK"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="space-y-0.5">
              <span className="text-slate-500">Modality</span>
              {/*
                v0.9.9 — TCIA modality dropdown. Pre-v0.9.9 this was free-text
                that users mistyped (e.g. "PET" → 0 hits because DICOM 0008,0060
                uses "PT"). Dropdown ships every DICOM modality TCIA / IDC
                commonly indexes, plus an "Any" sentinel that omits the filter.
                Modality codes are uppercase per DICOM convention.
              */}
              <select
                value={modality}
                onChange={(e) => setModality(e.target.value)}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="">Any modality</option>
                <option value="CT">CT — Computed Tomography</option>
                <option value="MR">MR — Magnetic Resonance</option>
                <option value="PT">PT — Positron Emission Tomography</option>
                <option value="CR">CR — Computed Radiography</option>
                <option value="DX">DX — Digital Radiography</option>
                <option value="MG">MG — Mammography</option>
                <option value="US">US — Ultrasound</option>
                <option value="NM">NM — Nuclear Medicine</option>
                <option value="XA">XA — X-Ray Angiography</option>
                <option value="RF">RF — Radio Fluoroscopy</option>
                <option value="SC">SC — Secondary Capture</option>
                <option value="SR">SR — Structured Report</option>
                <option value="SEG">SEG — Segmentation</option>
                <option value="RTSTRUCT">RTSTRUCT — RT Structure Set</option>
                <option value="RTDOSE">RTDOSE — RT Dose</option>
                <option value="RTPLAN">RTPLAN — RT Plan</option>
                <option value="RTIMAGE">RTIMAGE — RT Image</option>
                <option value="SM">SM — Slide Microscopy</option>
                <option value="OT">OT — Other</option>
              </select>
            </label>
            <label className="col-span-2 space-y-0.5">
              <span className="text-slate-500">Study description</span>
              <input
                type="text"
                value={studyDescription}
                onChange={(e) => setStudyDescription(e.target.value)}
                placeholder="abdomen, brain, chest…"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="space-y-0.5">
              <span className="text-slate-500">Study date or range</span>
              <input
                type="text"
                value={studyDate}
                onChange={(e) => setStudyDate(e.target.value)}
                placeholder="2010 · 2010-2015 · 2010-01 · 2010-01-15"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" onClick={handleSearch} disabled={searching} className="gap-1.5">
              {searching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              {searching ? 'Searching…' : 'Search'}
            </Button>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
              <span>{cacheLabel}</span>
              {cacheUsage.series > 0 && (
                <button
                  type="button"
                  onClick={handleClearCache}
                  title="Clear OPFS-cached IDC files"
                  className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
              {error}
            </div>
          )}

          {downloading && progress && (
            <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between gap-2">
                <span>Downloading {progress.loaded}/{progress.total} instances</span>
                <span className="tabular-nums text-slate-500">{progress.mb.toFixed(1)} MB</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-full bg-tamias-accent transition-all"
                  style={{ width: `${(progress.loaded / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
            </div>
          )}

          {results.length > 0 && (
            <ul className="max-h-80 space-y-1 overflow-y-auto">
              {results.map((s) => {
                const isOpen = expanded.has(s.StudyInstanceUID);
                const series = seriesByStudy[s.StudyInstanceUID];
                return (
                  <li
                    key={s.StudyInstanceUID}
                    className="rounded border border-slate-200 bg-white text-[11px] dark:border-slate-800 dark:bg-slate-900"
                  >
                    <button
                      type="button"
                      onClick={() => void toggleStudy(s)}
                      className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      {isOpen ? (
                        <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            {s.PatientID || '—'}
                          </span>
                          {s.Modalities.map((m) => (
                            <Badge key={m} variant="outline" className="text-[9px]">
                              {m}
                            </Badge>
                          ))}
                          <span className="text-[10px] text-slate-500">
                            {s.NumberOfSeries} series · {s.NumberOfInstances} instances
                          </span>
                        </div>
                        {s.StudyDescription && (
                          <div className="truncate text-[10px] text-slate-500" title={s.StudyDescription}>
                            {s.StudyDescription}
                          </div>
                        )}
                        {s.StudyDate && (
                          <div className="text-[10px] text-slate-400">{s.StudyDate}</div>
                        )}
                      </div>
                    </button>
                    {isOpen && (
                      <ul className="border-t border-slate-200 dark:border-slate-800">
                        {series === undefined ? (
                          <li className="px-2 py-1.5 text-[10px] text-slate-500">Loading…</li>
                        ) : series.length === 0 ? (
                          <li className="px-2 py-1.5 text-[10px] text-slate-500">No series</li>
                        ) : (
                          series
                            .slice()
                            .sort((a, b) => a.SeriesNumber - b.SeriesNumber)
                            .map((sr) => (
                              <li
                                key={sr.SeriesInstanceUID}
                                className="flex items-center gap-1.5 border-b border-slate-100 px-2 py-1.5 last:border-b-0 dark:border-slate-800"
                              >
                                <Badge variant="outline" className="text-[9px]">
                                  {sr.Modality}
                                </Badge>
                                <div className="min-w-0 flex-1">
                                  <div
                                    className="truncate text-slate-700 dark:text-slate-300"
                                    title={sr.SeriesDescription}
                                  >
                                    {sr.SeriesDescription || `Series ${sr.SeriesNumber}`}
                                  </div>
                                  <div className="text-[10px] text-slate-500">
                                    {sr.NumberOfInstances} instances
                                    {sr.BodyPart && ` · ${sr.BodyPart}`}
                                  </div>
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleDownload(sr)}
                                  disabled={downloading !== null}
                                  className="h-6 gap-1 px-1.5 text-[10px]"
                                  title="Download this series + load it in the viewer"
                                >
                                  {downloading === sr.SeriesInstanceUID ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Download className="h-3 w-3" />
                                  )}
                                  Load
                                </Button>
                              </li>
                            ))
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * v0.9.4 — coerce loose user date input into a DICOMweb-compliant
 * StudyDate filter value. The IDC proxy (Google Healthcare DICOM
 * store) only accepts:
 *   - YYYYMMDD            (single day)
 *   - YYYYMMDD-YYYYMMDD   (closed range)
 *   - -YYYYMMDD           (everything up to that day)
 *   - YYYYMMDD-           (everything from that day)
 *
 * Pre-v0.9.4 we just stripped dashes, so "2010" became "2010" (server
 * 400 "cannot be parsed as a date") and "2010-2015" became "20102015"
 * (same error). User report:
 *   "IDC search failed: 400 — 2010 cannot be parsed as a date"
 *
 * Now we expand each shorthand into a proper YYYYMMDD or
 * YYYYMMDD-YYYYMMDD range using sensible defaults:
 *   "2010"          → 20100101-20101231
 *   "2010-2015"     → 20100101-20151231
 *   "2010-01"       → 20100101-20100131
 *   "2010-01-15"    → 20100115
 *   "20100115"      → 20100115        (already valid)
 *   "2010-01-2015"  → 20100101-20151231 (interpreted as Y-M / Y range)
 *
 * Anything that doesn't match a known shape passes through as-is and
 * lets the server error so the user sees the raw message.
 */
function normalizeStudyDate(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  // Already in DICOM YYYYMMDD-YYYYMMDD shape (with optional open ends).
  if (/^\d{8}(-\d{8})?$/.test(raw) || /^-\d{8}$/.test(raw) || /^\d{8}-$/.test(raw)) {
    return raw;
  }
  // Range with a hyphen between two parts (each part = year, year-month, or year-month-day).
  const rangeMatch = raw.split(/\s*-\s*/);
  if (rangeMatch.length === 2 && rangeMatch[0] && rangeMatch[1]) {
    const start = expandDatePart(rangeMatch[0], 'start');
    const end = expandDatePart(rangeMatch[1], 'end');
    if (start && end) return `${start}-${end}`;
  }
  // Single year / year-month / year-month-day → expand to a single-day
  // or full-range filter as appropriate.
  if (/^\d{4}$/.test(raw)) {
    return `${raw}0101-${raw}1231`;
  }
  if (/^\d{4}-?\d{2}$/.test(raw)) {
    const y = raw.slice(0, 4);
    const m = raw.slice(-2);
    return `${y}${m}01-${y}${m}${lastDayOfMonth(+y, +m)}`;
  }
  if (/^\d{4}-?\d{2}-?\d{2}$/.test(raw)) {
    return raw.replace(/-/g, '');
  }
  // Unknown shape — let the server complain so the user sees a clear error.
  return raw;
}

function expandDatePart(part: string, edge: 'start' | 'end'): string | null {
  const t = part.trim();
  if (/^\d{4}$/.test(t)) {
    return edge === 'start' ? `${t}0101` : `${t}1231`;
  }
  if (/^\d{4}-?\d{2}$/.test(t)) {
    const y = t.slice(0, 4);
    const m = t.slice(-2);
    return edge === 'start' ? `${y}${m}01` : `${y}${m}${lastDayOfMonth(+y, +m)}`;
  }
  if (/^\d{4}-?\d{2}-?\d{2}$/.test(t)) {
    return t.replace(/-/g, '');
  }
  if (/^\d{8}$/.test(t)) return t;
  return null;
}

function lastDayOfMonth(year: number, monthIndex1: number): string {
  // monthIndex1 is 1-12; Date(y, m, 0).getDate() returns the last day
  // of month (m-1), which is exactly what we need.
  const d = new Date(year, monthIndex1, 0).getDate();
  return d.toString().padStart(2, '0');
}
