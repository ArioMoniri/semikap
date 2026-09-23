/**
 * Import already-computed results (the "Excel path").
 *
 * A user who scored two (or more) models offline exports a CSV/TSV — one row per
 * (case, model) with a `dice` column (and optionally `iou` / `hd95` / `assd`) —
 * and drops it here. Each row becomes an imported benchmark record, so the
 * existing comparison table and the statistical-comparison panel light up with
 * NO inference on this device. Nothing is uploaded.
 */

import { useRef, useState } from 'react';
import { FileSpreadsheet, Trash2 } from 'lucide-react';
import { useBenchmarkStore } from '../lib/state/benchmarkStore';
import { parseSegResultsCsv } from '../lib/stats/results-import';
import { segRowsToRecords } from '../lib/benchmark/import-records';
import { appendRecord } from '../lib/benchmark/store';
import { Button } from './ui/Button';

// Header-only template: every row the user imports must be their own measured result.
const TEMPLATE = 'caseId,model,dice,iou,hd95,assd\n';

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function BenchmarkResultsImportPanel() {
  const profileId = useBenchmarkStore((s) => s.currentProfileId);
  const records = useBenchmarkStore((s) => s.records);
  const setRecords = useBenchmarkStore((s) => s.setRecords);
  const inputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const importedCount = records.filter((r) => r.model.version === 'imported').length;

  async function onFile(file: File | undefined) {
    setNotice(null);
    setError(null);
    if (!file || !profileId) return;
    try {
      const text = await file.text();
      const rows = parseSegResultsCsv(text);
      if (rows.length === 0) {
        setError('No data rows found in that file.');
        return;
      }
      const recs = segRowsToRecords(rows, {
        profileId,
        appVersion: __APP_VERSION__,
        datasetName: file.name,
        createdAt: new Date().toISOString(),
      });
      // Persist + merge into the store, de-duplicating by record id so a
      // re-import of the same file replaces rather than doubles.
      for (const r of recs) await appendRecord(profileId, r);
      const byId = new Map(records.map((r) => [r.id, r]));
      for (const r of recs) byId.set(r.id, r);
      setRecords([...byId.values()]);
      const models = [...new Set(rows.map((r) => r.model))];
      setNotice(
        `Imported ${rows.length} row(s) across ${models.length} model(s): ${models.join(', ')}. ` +
          `The comparison table and statistical panel now include them.`,
      );
      if (inputRef.current) inputRef.current.value = '';
    } catch (e) {
      setError(`Could not import results: ${(e as Error).message}`);
    }
  }

  function clearImported() {
    setRecords(records.filter((r) => r.model.version !== 'imported'));
    setNotice('Cleared imported rows from this view. (Stored copies remain until you Clear all runs.)');
  }

  return (
    <section className="space-y-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
      <div className="font-semibold text-tamias-ink dark:text-slate-100">
        Import results (Excel / CSV)
      </div>
      <div className="text-slate-500 dark:text-slate-400">
        One row per <em>case, model</em> with a <code>dice</code> column (optionally{' '}
        <code>iou</code>, <code>hd95</code>, <code>assd</code>). Comma or TAB. No inference, no upload.
      </div>
      <label className="block text-slate-500 dark:text-slate-400">
        Results file (.csv / .tsv)
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
          className="mt-0.5 block w-full text-xs"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => download('tamias-results-template.csv', TEMPLATE, 'text/csv')}
        >
          <FileSpreadsheet className="h-3 w-3" /> Download template
        </Button>
        {importedCount > 0 && (
          <Button size="sm" variant="ghost" onClick={clearImported}>
            <Trash2 className="h-3 w-3" /> Remove imported ({importedCount})
          </Button>
        )}
      </div>
      {notice && <div className="text-emerald-600 dark:text-emerald-400">{notice}</div>}
      {error && <div className="text-red-500">{error}</div>}
    </section>
  );
}
