import { useMemo, useState } from 'react';
import { FileImage, Layers, Search, Trash2 } from 'lucide-react';
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
 *   `viewerRef`  v0.8.16 — used by the per-row Remove button to call
 *                `unloadAll()` on the underlying NiiVue wrapper before
 *                the store-level `setVolume(null)` cascade clears the
 *                React-side state (mask, result, SAM embedding, etc.).
 *                Without the viewer call NiiVue would keep the old
 *                volumes in its WebGL context and the next load would
 *                stack on top instead of replacing.
 */
export function LoadedImagesList({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const volume = useAppStore((s) => s.volume);
  const setVolume = useAppStore((s) => s.setVolume);
  const [filter, setFilter] = useState('');

  /**
   * v0.8.16 — remove-handler shared by every row's trash button.
   *
   * Order matters: tear down the GL/WebGPU side first (the NiiVue
   * wrapper's `unloadAll()` walks its volumes in reverse and calls
   * `removeVolume`, then resets brush bitmap + angle state + redraws),
   * THEN clear the zustand store. If we did it the other way around the
   * store update would re-render <Viewer> with `volume === null`, the
   * load-volume effect wouldn't fire (no volume to load), and the
   * NiiVue context would still be holding the old GPU textures.
   */
  function handleRemove() {
    viewerRef.current?.unloadAll();
    setVolume(null);
  }

  /**
   * Build the row list. v0.7.4 shows the primary + a "secondary
   * present" stub (we don't currently retain the secondary's bytes in
   * the store; the chip exists so the user can see at-a-glance that a
   * secondary is mounted). Future revisions track the secondary in the
   * store the same way the primary is.
   *
   * v0.8.16 — also surfaces the absolute `hint` path when the picker
   * was able to extract one (Tauri drag-drop / FSA picker on Chromium,
   * webkitRelativePath on folder picks). Browser PWAs leave `hint ===
   * name` so the row collapses back to the basename-only display.
   */
  const rows = useMemo(() => {
    const out: Array<{ kind: 'primary' | 'secondary'; name: string; path: string | null }> = [];
    if (volume) {
      const hint = volume.source.hint ?? '';
      out.push({
        kind: 'primary',
        name: volume.source.name,
        // Only treat the hint as a path when it differs from the bare
        // filename — otherwise the chip would render the basename twice.
        path: hint && hint !== volume.source.name ? hint : null,
      });
    }
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
                <div className="flex items-center justify-between gap-1">
                  {r.kind === 'primary' ? (
                    <Badge variant="ok" className="text-[9px]">
                      <FileImage className="mr-0.5 h-2.5 w-2.5" /> Primary
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px]">
                      <Layers className="mr-0.5 h-2.5 w-2.5" /> Secondary
                    </Badge>
                  )}
                  {r.kind === 'primary' && (
                    <button
                      type="button"
                      onClick={handleRemove}
                      title="Remove this series and free GPU memory"
                      aria-label={`Remove ${r.name}`}
                      className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-400/40 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <div className="truncate font-medium text-slate-700 dark:text-slate-300" title={r.name}>
                  {r.name}
                </div>
                {r.path && (
                  <div
                    className="truncate text-[10px] text-slate-500 dark:text-slate-400"
                    title={r.path}
                  >
                    {r.path}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
