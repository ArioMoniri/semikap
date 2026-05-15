import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';

/**
 * v0.9.1 — cross-series + display toggles.
 *
 * Mirrors OHIF's Tools menu items that toggle viewer behaviour
 * rather than adding measurements:
 *
 *   - **Reference Lines** — show coloured guides on each MPR tile
 *     indicating where the OTHER tiles cut through. NiiVue's native
 *     crosshair already provides this; this toggle just hides/shows
 *     the axis-coloured overlay introduced in v0.8.5.
 *   - **Image Slice Sync** — when a secondary series is loaded as
 *     an overlay, NiiVue's scene already shares the crosshair
 *     position so they scroll together. This toggle is here for UI
 *     parity with OHIF; the underlying sync is automatic.
 *   - **Segment Labels** — show the per-label legend chip.
 *   - **Slice chips** + **Study metadata** — re-exposed here for
 *     discoverability (also live in the floating eye toggle).
 *
 * Honest limit: Reference Lines + Slice Sync are conceptually about
 * MULTIPLE primary series displayed side-by-side. TAMIAS currently
 * has one primary + one overlay-secondary; true multi-pane reference
 * lines (see Frame A's slice on Frame B) needs the multi-primary
 * refactor tracked for v0.10.x.
 */
export function SyncPanel() {
  const showRef = useAppStore((s) => s.prefs.showReferenceLines);
  const sync = useAppStore((s) => s.prefs.syncSecondarySlice);
  const showSeg = useAppStore((s) => s.prefs.showSegmentLabels);
  const showChips = useAppStore((s) => s.prefs.showSliceChips);
  const showMeta = useAppStore((s) => s.prefs.showStudyMetaBadge);
  const setPrefs = useAppStore((s) => s.setPrefs);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wide text-slate-500">
          Display sync
        </CardTitle>
        <CardDescription className="text-[10px]">
          Toggle the OHIF-equivalent reference-line / sync / label overlays.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5 text-[11px]">
        <Toggle label="Reference lines" checked={showRef} onChange={(v) => setPrefs({ showReferenceLines: v })} />
        <Toggle label="Image slice sync (secondary)" checked={sync} onChange={(v) => setPrefs({ syncSecondarySlice: v })} />
        <Toggle label="Segment labels legend" checked={showSeg} onChange={(v) => setPrefs({ showSegmentLabels: v })} />
        <Toggle label="Per-tile slice chips" checked={showChips} onChange={(v) => setPrefs({ showSliceChips: v })} />
        <Toggle label="Study metadata badge" checked={showMeta} onChange={(v) => setPrefs({ showStudyMetaBadge: v })} />
      </CardContent>
    </Card>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-900">
      <span className="text-slate-700 dark:text-slate-300">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-tamias-accent"
      />
    </label>
  );
}
