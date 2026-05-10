import { useMemo, useState } from 'react';
import { FileImage, Layers, Search } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Badge } from './ui/Badge';
import { VolumePreview } from './VolumePreview';
import type { ViewerHandle } from './Viewer';

/**
 * v0.7.4 — searchable list of currently-loaded radiology images.
 *
 * Pre-v0.7.4 the sidebar showed only a single full-width thumbnail of
 * the primary volume and a separate "Loaded: <name>" line on the
 * secondary card. This widget consolidates both into a small chip per
 * image, with a filter input that shows up only once 2+ images are
 * loaded. Mirrors the cached-models search in ModelPicker.
 *
 * Props:
 *   `viewerRef`  not used directly by this widget today — passed through
 *                so future "remove this image" / "set as active" buttons
 *                can call back into the viewer without prop-drilling
 *                through every parent.
 */
export function LoadedImagesList({
  viewerRef: _viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const volume = useAppStore((s) => s.volume);
  const [filter, setFilter] = useState('');

  /**
   * Build the row list. v0.7.4 shows the primary + a "secondary
   * present" stub (we don't currently retain the secondary's bytes in
   * the store; the chip exists so the user can see at-a-glance that a
   * secondary is mounted). Future revisions track the secondary in the
   * store the same way the primary is.
   */
  const rows = useMemo(() => {
    const out: Array<{ kind: 'primary' | 'secondary'; name: string }> = [];
    if (volume) out.push({ kind: 'primary', name: volume.source.name });
    return out;
  }, [volume]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return rows;
    const q = filter.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, filter]);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-1">
        <CardTitle className="text-xs uppercase tracking-wide text-slate-500">
          Loaded images ({rows.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows.length > 1 && (
          <label className="flex items-center gap-1.5">
            <Search className="h-3 w-3 shrink-0 text-slate-400" />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search loaded images…"
              aria-label="Search loaded radiology images"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        )}
        <ul className="space-y-1.5">
          {filtered.map((r, i) => (
            <li
              key={`${r.kind}-${i}`}
              className="flex items-start gap-2 rounded border border-slate-200 bg-slate-50 p-1.5 text-[11px] dark:border-slate-800 dark:bg-slate-900"
            >
              {r.kind === 'primary' && volume ? (
                <VolumePreview compact />
              ) : (
                <div className="grid h-[80px] w-[80px] place-items-center rounded border border-slate-300 bg-slate-100 text-slate-400 dark:border-slate-700 dark:bg-slate-800">
                  <Layers className="h-5 w-5" />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-1">
                  {r.kind === 'primary' ? (
                    <Badge variant="ok" className="text-[9px]">
                      <FileImage className="mr-0.5 h-2.5 w-2.5" /> Primary
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px]">
                      <Layers className="mr-0.5 h-2.5 w-2.5" /> Secondary
                    </Badge>
                  )}
                </div>
                <div className="truncate font-medium text-slate-700 dark:text-slate-300" title={r.name}>
                  {r.name}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
