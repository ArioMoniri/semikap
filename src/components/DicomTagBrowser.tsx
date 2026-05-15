import { useMemo, useState } from 'react';
import { Search, Tag } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';

/**
 * v0.9.0 — DICOM Tag Browser.
 *
 * Mirrors OHIF's tool of the same name. Parses the loaded volume's
 * source bytes (when DICOM) via `dcmjs` and renders a searchable
 * table of every dataset tag with its VR, value, and human-readable
 * keyword.
 *
 * Limitations vs OHIF:
 *   - We only parse the FIRST instance the user loaded. For multi-
 *     frame series the per-frame functional groups appear, but we
 *     don't (yet) walk every instance — adding a slice navigator
 *     for tag inspection is a v0.9.x follow-up.
 *   - NIfTI / NRRD / MHA volumes don't have DICOM tags, so this
 *     widget shows a hint instead of a table for those.
 *
 * Designed as a CollapsibleSection child so it costs nothing when
 * the user doesn't open it (parsing is lazy on first expand).
 */
export function DicomTagBrowser() {
  const volume = useAppStore((s) => s.volume);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [tags, setTags] = useState<Array<{ tag: string; vr: string; keyword: string; value: string }> | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDicom = useMemo(() => {
    if (!volume) return false;
    return /\.dcm(\.gz)?$|\.dicom$|^idc:/i.test(
      volume.source.name + ' ' + (volume.source.hint ?? '')
    );
  }, [volume]);

  const filtered = useMemo(() => {
    if (!tags) return [];
    if (!filter.trim()) return tags;
    const q = filter.toLowerCase();
    return tags.filter(
      (t) =>
        t.tag.toLowerCase().includes(q) ||
        t.keyword.toLowerCase().includes(q) ||
        t.value.toLowerCase().includes(q)
    );
  }, [tags, filter]);

  async function parseTags() {
    if (!volume) return;
    setParsing(true);
    setError(null);
    try {
      // Lazy-load dcmjs only when the user opens the tag browser. v0.9.0
      // — keeps the initial bundle small (dcmjs is ~400 KB minified).
      const dcmjs = await import('dcmjs');
      const dataset = (dcmjs as unknown as {
        data: {
          DicomMessage: { readFile(buf: ArrayBuffer): { dict: Record<string, { vr: string; Value?: unknown[] }> } };
          DicomMetaDictionary: {
            namifyDataset(d: Record<string, unknown>): Record<string, unknown>;
            nameMap: Record<string, { tag: string; vr: string; name: string }>;
          };
        };
      }).data.DicomMessage.readFile(volume.source.bytes.buffer.slice(0));
      const out: Array<{ tag: string; vr: string; keyword: string; value: string }> = [];
      const nameMap = (dcmjs as unknown as {
        data: { DicomMetaDictionary: { nameMap: Record<string, { tag: string; vr: string; name: string }> } };
      }).data.DicomMetaDictionary.nameMap;
      const reverseNameMap = Object.entries(nameMap).reduce<Record<string, string>>(
        (acc, [keyword, info]) => {
          // info.tag is like "(0010,0010)" — strip parens + comma to
          // match dataset.dict's "00100010" key format.
          const hex = info.tag.replace(/[(),]/g, '');
          acc[hex] = keyword;
          return acc;
        },
        {}
      );
      for (const [tag, entry] of Object.entries(dataset.dict)) {
        const value = formatValue(entry.Value);
        out.push({
          tag: `(${tag.slice(0, 4)},${tag.slice(4)})`,
          vr: entry.vr ?? '',
          keyword: reverseNameMap[tag] ?? '',
          value,
        });
      }
      out.sort((a, b) => a.tag.localeCompare(b.tag));
      setTags(out);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setParsing(false);
    }
  }

  if (!volume) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-tamias-accent" /> DICOM tag browser
          </CardTitle>
          <CardDescription>
            {isDicom ? 'Parse + search every tag in the source DICOM' : 'Available for DICOM-source volumes only'}
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && tags === null && isDicom) void parseTags();
          }}
          disabled={!isDicom}
        >
          {open ? 'Hide' : 'Open'}
        </Button>
      </CardHeader>
      {open && isDicom && (
        <CardContent className="space-y-2">
          {parsing && <div className="text-xs text-slate-500">Parsing dataset…</div>}
          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
              {error}
            </div>
          )}
          {tags && tags.length > 0 && (
            <>
              <label className="flex items-center gap-1.5">
                <Search className="h-3 w-3 shrink-0 text-slate-400" />
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by tag, keyword, or value…"
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <div className="max-h-80 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
                <table className="w-full table-fixed text-[10px]">
                  <thead className="sticky top-0 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="w-24 px-1.5 py-1 text-left">Tag</th>
                      <th className="w-10 px-1.5 py-1 text-left">VR</th>
                      <th className="w-32 px-1.5 py-1 text-left">Keyword</th>
                      <th className="px-1.5 py-1 text-left">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 500).map((t) => (
                      <tr
                        key={t.tag}
                        className="border-b border-slate-100 last:border-b-0 dark:border-slate-800"
                      >
                        <td className="truncate px-1.5 py-0.5 font-mono">{t.tag}</td>
                        <td className="px-1.5 py-0.5">{t.vr}</td>
                        <td className="truncate px-1.5 py-0.5 text-slate-500">{t.keyword}</td>
                        <td
                          className="truncate px-1.5 py-0.5 text-slate-700 dark:text-slate-300"
                          title={t.value}
                        >
                          {t.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[10px] text-slate-500">
                Showing {Math.min(500, filtered.length)} of {filtered.length} tags
                {filtered.length > 500 && ' (cap 500 — narrow the filter to see more)'}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * Compress a DICOM `Value` array into a human-readable cell. Skips
 * binary blobs (PixelData, large encapsulated frames) so the table
 * doesn't render multi-MB hex dumps.
 */
function formatValue(value: unknown[] | undefined): string {
  if (!value || value.length === 0) return '';
  if (value.length === 1) {
    const v = value[0];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      // PersonName, SequenceOfItems, BulkDataURI — render compactly
      // rather than dumping the JSON.
      const obj = v as Record<string, unknown>;
      if ('Alphabetic' in obj) return String(obj.Alphabetic);
      if ('BulkDataURI' in obj) return `<binary @ ${String(obj.BulkDataURI).slice(-20)}>`;
      if ('InlineBinary' in obj) {
        const b = obj.InlineBinary as string;
        return `<binary, ${b.length} chars>`;
      }
      return JSON.stringify(v).slice(0, 80);
    }
    return String(v);
  }
  return value.map((v) => (typeof v === 'object' ? '{…}' : String(v))).join(' / ');
}
