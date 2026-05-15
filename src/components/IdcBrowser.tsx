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
      const studies = await searchStudies({
        ...(patientId && { PatientID: patientId.trim() }),
        ...(modality && { ModalitiesInStudy: modality.trim() }),
        ...(studyDescription && { StudyDescription: studyDescription.trim() }),
        ...(studyDate && { StudyDate: studyDate.trim().replace(/-/g, '') }),
        limit: 50,
      });
      setResults(studies);
      if (studies.length === 0) setError('No studies match those filters.');
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
            <Cloud className="h-4 w-4 text-tamias-accent" /> IDC public data
          </CardTitle>
          <CardDescription>
            NCI Imaging Data Commons — search + download CT / MR / PET. No login needed.
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
              <input
                type="text"
                value={modality}
                onChange={(e) => setModality(e.target.value)}
                placeholder="CT, MR, PT…"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              />
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
              <span className="text-slate-500">Study date (YYYY-MM-DD or range)</span>
              <input
                type="text"
                value={studyDate}
                onChange={(e) => setStudyDate(e.target.value)}
                placeholder="e.g. 2010-2015"
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
