import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, X, Crosshair } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { detectBackend } from '../lib/diagnostics/gpu';
import type { ProbeReading } from './Viewer';
import { LocalFilePicker } from './LocalFilePicker';
import { SecondarySeriesPicker } from './SecondarySeriesPicker';
import { ModelPicker } from './ModelPicker';
import { Viewer } from './Viewer';
import type { ViewerHandle } from './Viewer';
import { InferencePanel } from './InferencePanel';
import { ExportPanel } from './ExportPanel';
import { GpuInfoPanel } from './GpuInfoPanel';
import { OverlayControls } from './OverlayControls';
import { AnnotationPanel } from './AnnotationPanel';
import { SettingsPanel } from './SettingsPanel';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Separator } from './ui/Separator';
import { appendAudit } from '../lib/fs/audit';
import type { PickedFile } from '../lib/fs/filesystem';

export function AppShell() {
  const backend = useAppStore((s) => s.backend);
  const setBackend = useAppStore((s) => s.setBackend);
  const setVolume = useAppStore((s) => s.setVolume);
  const volume = useAppStore((s) => s.volume);
  const model = useAppStore((s) => s.model);
  const setModel = useAppStore((s) => s.setModel);
  const errors = useAppStore((s) => s.errors);
  const clearErrors = useAppStore((s) => s.clearErrors);
  const pushError = useAppStore((s) => s.pushError);

  const viewerRef = useRef<ViewerHandle | null>(null);
  const [studyHint, setStudyHint] = useState<string>('');
  const [probe, setProbe] = useState<ProbeReading | null>(null);

  useEffect(() => {
    // Wait one tick so the imperative handle is wired up before subscribing.
    const id = window.setTimeout(() => {
      const v = viewerRef.current;
      if (!v) return;
      const off = v.onProbe(setProbe);
      cleanup = off;
    }, 0);
    let cleanup: (() => void) | undefined;
    return () => {
      window.clearTimeout(id);
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    detectBackend()
      .then((b) => {
        setBackend(b);
        void appendAudit({
          kind: 'app-start',
          message: `Booted on ${b.provider.toUpperCase()}${
            b.adapter ? ` (${b.adapter.vendor})` : ''
          }`,
          details: { provider: b.provider, isolated: b.crossOriginIsolated },
        });
      })
      .catch((e: Error) => pushError(`GPU detection failed: ${e.message}`));
  }, [setBackend, pushError]);

  const handleImagePicked = useCallback(
    async (file: PickedFile) => {
      try {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        const loaded = await viewerRef.current.loadPrimary(file.name, file.bytes);
        setVolume({ source: file, voxels: loaded.voxels, meta: loaded.meta });
        setStudyHint(file.name);
      } catch (e) {
        pushError(`Failed to load image: ${(e as Error).message}`);
      }
    },
    [setVolume, pushError]
  );

  const handleResultMask = useCallback(
    async (
      mask: Uint8Array,
      dims: [number, number, number],
      spacing: [number, number, number]
    ) => {
      if (!viewerRef.current) return;
      const overlay = useAppStore.getState().overlay;
      await viewerRef.current.addMaskOverlay(
        'mask',
        mask,
        dims,
        spacing,
        overlay.colormap,
        overlay.opacity
      );
    },
    []
  );

  const studyMeta = useMemo(() => {
    if (!volume) return null;
    const [x, y, z] = volume.meta.dims;
    const [sx, sy, sz] = volume.meta.spacing;
    return {
      dims: `${x} × ${y} × ${z}`,
      spacing: `${sx.toFixed(2)} × ${sy.toFixed(2)} × ${sz.toFixed(2)} mm`,
      dtype: volume.meta.dtype,
    };
  }, [volume]);

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 bg-tamias-ink px-4 py-2 text-white">
        <div className="flex items-center gap-3">
          <div className="font-bold tracking-wide">TAMIAS</div>
          <Separator orientation="vertical" className="h-4 bg-white/20" />
          <span className="text-xs text-white/70">Transparent locAl Medical Image AnalysiS</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="ok" className="gap-1">
            <ShieldCheck className="h-3 w-3" /> No upload
          </Badge>
          {backend && (
            <Badge variant={backend.provider === 'webgpu' ? 'accent' : 'outline'}>
              {backend.provider.toUpperCase()}
              {backend.adapter ? ` · ${backend.adapter.vendor}` : ''}
            </Badge>
          )}
          <Badge variant="outline">v{__APP_VERSION__}</Badge>
        </div>
      </header>

      <main className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-[400px_1fr]">
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3">
          <GpuInfoPanel backend={backend} />
          <LocalFilePicker onPicked={handleImagePicked} current={volume?.source ?? null} />
          <SecondarySeriesPicker viewerRef={viewerRef} />
          <ModelPicker onLoaded={setModel} current={model} />
          <InferencePanel onResultMask={handleResultMask} />
          <OverlayControls viewerRef={viewerRef} />
          <AnnotationPanel viewerRef={viewerRef} />
          <ExportPanel viewerRef={viewerRef} />
          <SettingsPanel />
          {errors.length > 0 && (
            <Card className="border-red-200 bg-red-50">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-red-700">Errors</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-red-700 hover:bg-red-100"
                  onClick={clearErrors}
                  aria-label="Clear errors"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-red-700">
                  {errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </aside>
        <section id="viewer" tabIndex={-1} className="relative min-h-0 bg-black" aria-label="Image viewer">
          <Viewer ref={viewerRef} />
          {studyMeta && (
            <div
              className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/80 backdrop-blur"
              role="status"
              aria-label="Study metadata"
            >
              <div className="truncate font-medium" title={studyHint}>
                {studyHint}
              </div>
              <div className="text-white/60">
                {studyMeta.dims} · {studyMeta.spacing} · {studyMeta.dtype}
              </div>
            </div>
          )}
          {probe && volume && (
            <div
              className="pointer-events-none absolute right-2 top-2 flex items-center gap-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/80 backdrop-blur"
              role="status"
              aria-label="Cursor probe"
            >
              <Crosshair className="h-3 w-3" />
              <div className="tabular-nums text-white/70">
                vox [{probe.voxel.map((n) => n.toFixed(0)).join(', ')}]
              </div>
              <div className="tabular-nums text-white/70">
                mm [{probe.mm.map((n) => n.toFixed(1)).join(', ')}]
              </div>
              <div className="tabular-nums text-white">
                {Number.isFinite(probe.value) ? probe.value.toFixed(2) : '—'}
              </div>
            </div>
          )}
          {!volume && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/50">
              <div className="space-y-1 text-center">
                <div className="text-base font-semibold text-white/70">No image loaded</div>
                <div>Pick a DICOM, NIfTI, or NRRD on the left to begin.</div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
