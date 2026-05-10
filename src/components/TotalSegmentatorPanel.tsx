import { useCallback, useState } from 'react';
import { Layers, Download, FolderOpen, X as XIcon } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Progress } from './ui/Progress';
import { ExternalLink } from './ExternalLink';
import {
  PRESET_TOTALSEG_MODELS,
  buildCustomTotalSegManifest,
  loadTotalSegModel,
  type TotalSegLoadProgress,
} from '../lib/totalseg/loader';
import {
  parseTotalSegManifest,
  type TotalSegManifest,
} from '../lib/totalseg/types';
import { pickFile, readDroppedFiles } from '../lib/fs/filesystem';
import { appendAudit } from '../lib/fs/audit';
import type { ViewerHandle } from './Viewer';
import { cn } from '../lib/ui/cn';

const TOTALSEG_DOC_URL =
  'https://github.com/ArioMoniri/semikap/blob/main/docs/TOTALSEGMENTATOR.md';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

/**
 * v0.7.4 — TotalSegmentator (whole-body anatomical segmentation) panel.
 *
 * Status: **preview**. The official upstream
 * (https://github.com/wasserth/TotalSegmentator) ships only Python /
 * nnUNet weights, so v0.7.4 ships a BYO-URL onboarding flow + a stub
 * runtime. As soon as a community ONNX export lands the preset list
 * grows in `src/lib/totalseg/loader.ts` and inference wires through
 * the same browser-only path SAM uses.
 *
 * UX: same three-state pattern as SamPanel (no model → loading →
 * ready). The "Run" button stays disabled in v0.7.4 with a tooltip
 * pointing at docs/TOTALSEGMENTATOR.md so the user understands they're
 * looking at a scaffold, not a finished tool.
 */
export function TotalSegmentatorPanel({ viewerRef: _viewerRef }: Props) {
  const pushError = useAppStore((s) => s.pushError);

  const [modelLoaded, setModelLoaded] = useState<TotalSegManifest | null>(null);
  const [busy, setBusy] = useState<{
    stage: 'fetching' | 'verify' | 'cache' | 'done';
    label: string;
    bytesLoaded: number;
    bytesTotal?: number;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  /**
   * Inline custom-URL form. Same shape as the SAM panel form (see
   * SamPanel.tsx) so the UX is consistent across the two on-prem
   * inference families.
   */
  const [byoForm, setByoForm] = useState<{
    open: boolean;
    name: string;
    modelUrl: string;
    sha256: string;
  }>({ open: false, name: '', modelUrl: '', sha256: '' });

  const openByo = useCallback(() => {
    setByoForm({
      open: true,
      name: 'TotalSegmentator (BYO)',
      modelUrl: '',
      sha256: '',
    });
  }, []);

  const closeByo = useCallback(() => {
    setByoForm({ open: false, name: '', modelUrl: '', sha256: '' });
  }, []);

  const submitByo = useCallback(async () => {
    if (!byoForm.name.trim() || !byoForm.modelUrl.trim()) {
      pushError('TotalSeg BYO: name and model URL are required.');
      return;
    }
    const manifest = buildCustomTotalSegManifest({
      name: byoForm.name.trim(),
      modelUrl: byoForm.modelUrl.trim(),
      ...(byoForm.sha256.trim() ? { sha256: byoForm.sha256.trim() } : {}),
    });
    closeByo();
    try {
      setBusy({
        stage: 'fetching',
        label: 'Downloading TotalSegmentator model…',
        bytesLoaded: 0,
      });
      await loadTotalSegModel(manifest, (p: TotalSegLoadProgress) => {
        setBusy({
          stage: p.stage,
          label:
            p.stage === 'fetching'
              ? 'Downloading TotalSegmentator model…'
              : p.stage === 'verify'
              ? 'Verifying SHA-256…'
              : p.stage === 'cache'
              ? 'Caching to OPFS…'
              : 'Done',
          bytesLoaded: p.bytesLoaded,
          ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}),
        });
      });
      setModelLoaded(manifest);
      setBusy(null);
      void appendAudit({
        kind: 'export',
        message: `TotalSegmentator model loaded (BYO): ${manifest.name}`,
      });
    } catch (e) {
      const err = e as Error;
      pushError(`TotalSegmentator load failed: ${err.message}`);
      setBusy(null);
    }
  }, [byoForm, closeByo, pushError]);

  /**
   * Pick a manifest .json from disk + an .onnx blob in turn. Same
   * pattern as the radiology ModelPicker but scoped to the TotalSeg
   * manifest schema (see src/lib/totalseg/types.ts).
   */
  const handlePickLocal = useCallback(async () => {
    try {
      const manifestFile = await pickFile({ 'application/json': ['.json'] });
      if (!manifestFile) return;
      const text = new TextDecoder().decode(manifestFile.bytes);
      const manifest = parseTotalSegManifest(JSON.parse(text));
      // The model bytes themselves aren't loaded here in v0.7.4 — the
      // runtime stub picks them up at Run-time. This keeps the panel
      // testable end-to-end without a working ORT pipeline.
      setModelLoaded(manifest);
      void appendAudit({
        kind: 'export',
        message: `TotalSegmentator manifest loaded from disk: ${manifest.name}`,
      });
    } catch (e) {
      pushError(`TotalSegmentator manifest load failed: ${(e as Error).message}`);
    }
  }, [pushError]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      setDragOver(false);
      const dropped = await readDroppedFiles(e.nativeEvent);
      const json = dropped.find((f) => f.name.toLowerCase().endsWith('.json'));
      if (!json) {
        pushError(
          'TotalSegmentator drop: include a manifest .json (model .onnx is fetched on demand).'
        );
        return;
      }
      try {
        const text = new TextDecoder().decode(json.bytes);
        const manifest = parseTotalSegManifest(JSON.parse(text));
        setModelLoaded(manifest);
      } catch (err) {
        pushError(
          `TotalSegmentator manifest invalid: ${(err as Error).message}`
        );
      }
    },
    [pushError]
  );

  const handleForget = useCallback(() => {
    setModelLoaded(null);
  }, []);

  return (
    <Card
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void handleDrop(e)}
      className={cn(
        'border-2 border-dashed transition-colors',
        dragOver ? 'border-tamias-accent bg-blue-50 dark:bg-blue-950/30' : 'border-slate-200'
      )}
    >
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-tamias-accent" /> TotalSegmentator
          </CardTitle>
          <CardDescription>
            Whole-body anatomical segmentation. Preview · BYO ONNX URL.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {busy && <BusyView busy={busy} />}

        {!modelLoaded && !busy && (
          <div className="space-y-2">
            <div className="text-slate-600 dark:text-slate-300">
              No upstream ONNX export yet. Paste a community-converted URL or
              load a manifest from disk. Once loaded, runs entirely on this
              device — no network for inference.
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              <Button
                variant="ink"
                size="sm"
                className="justify-start gap-1.5"
                onClick={handlePickLocal}
              >
                <FolderOpen className="h-3.5 w-3.5" /> Pick local manifest .json
              </Button>
              {/* v0.7.5 — shorten the preset label so it fits the
                  outline button at the narrowest sidebar width. The
                  trailing "BYO URL · Bring your own" used to overflow
                  the button outline (same overflow class as v0.7.1's
                  SAM 3 entry). The trailing chip is now a tiny "BYO"
                  badge and the truncation lives on the label span. */}
              {PRESET_TOTALSEG_MODELS.map((p) => (
                <Button
                  key={p.id}
                  variant="outline"
                  size="sm"
                  className="justify-between gap-1.5"
                  onClick={openByo}
                  title={`${p.manifest.name} — opens the BYO URL form`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Download className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">TotalSegmentator</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-500">BYO</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {byoForm.open && !busy && (
          <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              TotalSegmentator — BYO URL
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-600 dark:text-slate-300">
                Name
              </span>
              <input
                type="text"
                value={byoForm.name}
                onChange={(e) =>
                  setByoForm((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="TotalSegmentator v2"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-600 dark:text-slate-300">
                Model ONNX URL
              </span>
              <input
                type="url"
                value={byoForm.modelUrl}
                onChange={(e) =>
                  setByoForm((prev) => ({ ...prev, modelUrl: e.target.value }))
                }
                placeholder="https://huggingface.co/.../totalseg.onnx"
                spellCheck={false}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-600 dark:text-slate-300">
                SHA-256 (optional)
              </span>
              <input
                type="text"
                value={byoForm.sha256}
                onChange={(e) =>
                  setByoForm((prev) => ({ ...prev, sha256: e.target.value }))
                }
                placeholder="64-char hex digest"
                spellCheck={false}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <div className="flex gap-1.5 pt-1">
              <Button
                size="sm"
                variant="ink"
                onClick={() => void submitByo()}
                disabled={!byoForm.name.trim() || !byoForm.modelUrl.trim()}
                className="flex-1 gap-1.5"
              >
                <Download className="h-3.5 w-3.5" /> Download &amp; load
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={closeByo}
                className="flex-1 gap-1.5"
              >
                <XIcon className="h-3.5 w-3.5" /> Cancel
              </Button>
            </div>
          </div>
        )}

        {modelLoaded && !busy && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-emerald-50 px-2 py-1 dark:border-slate-800 dark:bg-emerald-950">
              <div className="flex min-w-0 items-center gap-1.5 text-emerald-800 dark:text-emerald-300">
                <Layers className="h-3 w-3 shrink-0" />
                <span className="truncate text-[11px]">{modelLoaded.name}</span>
                <Badge variant="ok" className="ml-1 text-[10px]">
                  {modelLoaded.output.classes} classes
                </Badge>
              </div>
              <button
                type="button"
                onClick={handleForget}
                aria-label="Forget loaded TotalSegmentator model"
                className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
                title="Unload model"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
            {/* v0.7.5 — replaces the disabled "Run on current volume
                (preview)" button. The disabled button looked broken in
                user testing ("still this button does nothing"), so we
                surface the real status (no upstream ONNX export yet) +
                a one-tap link to the upstream Python tool instead. */}
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
              <div className="font-medium">Inference runtime — coming next</div>
              <div className="mt-0.5">
                Upstream ships only nnUNet weights;{' '}
                <ExternalLink
                  href="https://github.com/wasserth/TotalSegmentator"
                  className="underline"
                >
                  wasserth/TotalSegmentator
                </ExternalLink>{' '}
                converts on Python. Browser ONNX runtime lands once a
                community export is ready.
              </div>
            </div>
          </div>
        )}

        {/* v0.7.5 — collapsed the "See docs" badge into a compact full-
            width chip. The previous Badge wrap-flowed at narrow sidebar
            widths because Badge's flex-row + auto-wrap fights with the
            ExternalLink's nested span. A plain anchor in a flex-row
            with `flex-wrap` keeps it tidy on every width. */}
        <a
          href={TOTALSEG_DOC_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-900 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200 dark:hover:bg-amber-900/30"
        >
          docs/TOTALSEGMENTATOR.md — manifest schema + ONNX export progress
        </a>
      </CardContent>
    </Card>
  );
}

function BusyView({
  busy,
}: {
  busy: {
    stage: string;
    label: string;
    bytesLoaded: number;
    bytesTotal?: number;
  };
}) {
  let pct = -1;
  if (busy.stage === 'fetching' && busy.bytesTotal) {
    pct = Math.round((busy.bytesLoaded / busy.bytesTotal) * 100);
  }
  return (
    <div className="space-y-1.5 rounded border border-blue-200 bg-blue-50 p-2 dark:border-blue-900 dark:bg-blue-950">
      <div className="text-[11px] font-medium text-blue-900 dark:text-blue-200">
        {busy.label}
      </div>
      {pct >= 0 ? (
        <Progress value={pct} />
      ) : (
        <div className="h-2 w-full animate-pulse rounded-full bg-blue-200" />
      )}
      {busy.stage === 'fetching' && (
        <div className="text-[10px] tabular-nums text-blue-800/70 dark:text-blue-200/60">
          {(busy.bytesLoaded / (1024 * 1024)).toFixed(1)} MB
          {busy.bytesTotal
            ? ` / ${(busy.bytesTotal / (1024 * 1024)).toFixed(1)} MB`
            : ''}
        </div>
      )}
    </div>
  );
}
