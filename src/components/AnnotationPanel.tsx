import { useCallback, useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { Brush, Eraser, RotateCcw, Sparkles, Wand2 } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import type { SamApi } from '../workers/sam.worker';
import type { SamSliceEmbedding, SamMaskResult } from '../lib/sam/types';
import { appendAudit } from '../lib/fs/audit';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

type Mode = 'off' | 'brush' | 'eraser' | 'smart';

/**
 * Brush palette. The label index is what NiiVue writes into the draw bitmap;
 * the colour swatch is what NiiVue paints for that label after we install
 * the matching RGB into `nv.drawLut.lut` in the viewer constructor. So a
 * manifest with one label still gets six brush colours to choose from —
 * the user just picks which of label 1..6 is the active brush colour.
 */
const BRUSH_PALETTE: Array<{ label: number; name: string; color: string }> = [
  { label: 1, name: 'Red',     color: '#ef4444' },
  { label: 2, name: 'Green',   color: '#22c55e' },
  { label: 3, name: 'Blue',    color: '#3b82f6' },
  { label: 4, name: 'Yellow',  color: '#eab308' },
  { label: 5, name: 'Cyan',    color: '#06b6d4' },
  { label: 6, name: 'Magenta', color: '#d946ef' },
];

export function AnnotationPanel({ viewerRef }: Props) {
  const result = useAppStore((s) => s.result);
  const model = useAppStore((s) => s.model);
  const samState = useAppStore((s) => s.sam);
  const pushError = useAppStore((s) => s.pushError);
  const [mode, setMode] = useState<Mode>('off');
  const [label, setLabel] = useState<number>(1);
  const smartBusy = useRef(false);

  // Manifest labels are still used for tooltips on the colour swatches so
  // the user sees e.g. "Red · liver" when the model author named label 1.
  const labels = model?.manifest.output.labels ?? {};

  useEffect(() => {
    if (!viewerRef.current) return;
    if (mode === 'off' || mode === 'smart') {
      // Smart mode handles painting itself via SAM — disable NiiVue's
      // own drawing handlers so a click goes to our overlay path instead
      // of writing a single voxel.
      viewerRef.current.setDrawingEnabled(false);
    } else {
      viewerRef.current.setDrawingEnabled(true);
      viewerRef.current.setBrushLabel(mode === 'eraser' ? 0 : label);
    }
  }, [mode, label, viewerRef]);

  /**
   * Phase C.2 — single-stroke smart-brush. The user clicks anywhere on
   * the slice; we auto-encode the slice (cached if already done), run
   * the SAM decoder with that single positive point, and merge the
   * resulting mask straight into NiiVue's brush layer at the active
   * label. No "Generate" or "Commit" button — one click → snapped
   * contour.
   */
  const handleSmartClick = useCallback(
    async (clickX: number, clickY: number) => {
      if (smartBusy.current) return;
      const sam = useAppStore.getState().sam;
      if (!sam.modelLoaded || !sam.manifest || !sam.encoderBytes || !sam.decoderBytes) {
        pushError('Load a SAM model first (open the SAM panel above).');
        return;
      }
      const v = viewerRef.current;
      if (!v) return;
      const voxel = v.canvasToAxialVoxel(clickX, clickY);
      if (!voxel) return;
      const slice = v.getCurrentAxialSlice();
      if (!slice) return;

      smartBusy.current = true;
      try {
        const worker = new Worker(
          new URL('../workers/sam.worker.ts', import.meta.url),
          { type: 'module' }
        );
        const api = Comlink.wrap<SamApi>(worker);
        // Encode the slice. For the same slice index we could reuse the
        // SamPanel's cached embedding, but cross-component caching is
        // fragile so we re-encode here. Encoder is ~1-3s on WebGPU; for
        // a single click that's acceptable.
        const enc = (await api.encode({
          kind: 'encode',
          manifest: sam.manifest,
          encoderBytes: sam.encoderBytes,
          pixels: slice.pixels,
          inputMode: 'gray',
          width: slice.width,
          height: slice.height,
        })) as SamSliceEmbedding;
        const dec = (await api.decode({
          kind: 'decode',
          manifest: sam.manifest,
          decoderBytes: sam.decoderBytes,
          embedding: enc.embedding,
          prompts: [{ kind: 'point', xy: [voxel.x, voxel.y], label: 1 }],
          width: slice.width,
          height: slice.height,
        })) as SamMaskResult;
        worker.terminate();

        // Merge into the NiiVue brush layer at the active brush label.
        // We expose this through addMaskOverlay (single-slice volume) so
        // the result inherits the v0.5.5 RAS-alignment fix. Subsequent
        // smart clicks add to the same overlay.
        const volume = useAppStore.getState().volume;
        if (!volume) return;
        const [X, Y, Z] = volume.meta.dims;
        const slab = X * Y;
        const full = new Uint8Array(X * Y * Z);
        const offset = slice.index * slab;
        for (let i = 0; i < slab; i++) full[offset + i] = dec.mask[i] ?? 0;
        await v.addMaskOverlay(
          'smart-brush',
          full,
          [X, Y, Z],
          volume.meta.spacing,
          'green',
          0.5,
          {
            ...(volume.meta.srowX ? { srowX: volume.meta.srowX } : {}),
            ...(volume.meta.srowY ? { srowY: volume.meta.srowY } : {}),
            ...(volume.meta.srowZ ? { srowZ: volume.meta.srowZ } : {}),
            origin: volume.meta.origin,
          }
        );
        void appendAudit({
          kind: 'export',
          message: `Smart brush: SAM mask ${(dec.score * 100).toFixed(0)}% IoU on slice ${slice.index + 1}`,
        });
      } catch (e) {
        const err = e as Error;
        pushError(
          `Smart brush failed: ${err.message}`,
          err.stack ? { stack: err.stack } : undefined
        );
      } finally {
        smartBusy.current = false;
      }
    },
    [viewerRef, pushError]
  );

  // Auto-disable drawing when the mask is removed.
  useEffect(() => {
    if (!result && mode !== 'off') setMode('off');
  }, [result, mode]);

  // Smart-brush click capture. While in smart mode we listen at the document
  // level (capture phase) so we intercept the click BEFORE NiiVue's own
  // canvas handlers run — drawing is already disabled by the mode effect
  // above, but using capture also prevents accidental scrubbing of the
  // crosshair on slow encodes. We resolve the active canvas by walking up
  // from the event target so the listener works regardless of whether the
  // user clicks the axial / coronal / sagittal pane.
  useEffect(() => {
    if (mode !== 'smart') return;
    const handler = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const canvas = target.closest('canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      ev.preventDefault();
      ev.stopPropagation();
      void handleSmartClick(x, y);
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [mode, handleSmartClick]);

  const handleUndo = useCallback(() => {
    viewerRef.current?.undoLastBrushStroke();
  }, [viewerRef]);

  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brush className="h-4 w-4 text-tamias-accent" /> Correct mask
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-slate-500">
          Run inference to enable brush/eraser corrections on the mask.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2">
          <Brush className="h-4 w-4 text-tamias-accent" /> Correct mask
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={mode === 'brush' ? 'default' : 'outline'}
            onClick={() => setMode((m) => (m === 'brush' ? 'off' : 'brush'))}
            aria-pressed={mode === 'brush'}
            className="gap-1.5"
          >
            <Brush className="h-3.5 w-3.5" /> Brush
          </Button>
          <Button
            size="sm"
            variant={mode === 'eraser' ? 'default' : 'outline'}
            onClick={() => setMode((m) => (m === 'eraser' ? 'off' : 'eraser'))}
            aria-pressed={mode === 'eraser'}
            className="gap-1.5"
          >
            <Eraser className="h-3.5 w-3.5" /> Eraser
          </Button>
          <Button
            size="sm"
            variant={mode === 'smart' ? 'default' : 'outline'}
            onClick={() => setMode((m) => (m === 'smart' ? 'off' : 'smart'))}
            aria-pressed={mode === 'smart'}
            disabled={!samState?.modelLoaded}
            title={
              samState?.modelLoaded
                ? 'Single-click smart brush: SAM segments under the cursor.'
                : 'Load a SAM model in the SAM panel to enable smart brush.'
            }
            className="gap-1.5"
          >
            <Wand2 className="h-3.5 w-3.5" /> Smart
          </Button>
          <Button size="sm" variant="ghost" onClick={handleUndo} className="gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" /> Undo
          </Button>
        </div>

        {/* Smart-brush hint. Phase C.2 wires single-click → SAM mask
            straight into this panel; the SAM section above remains the
            place to load weights and run multi-prompt (point + box +
            text) refinement. */}
        <div className="flex items-start gap-1.5 rounded border border-tamias-accent/30 bg-blue-50 p-2 text-[11px] text-tamias-ink dark:bg-blue-950 dark:text-slate-200">
          <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-tamias-accent" />
          <span>
            <span className="font-medium">Tip:</span>{' '}
            {samState?.modelLoaded ? (
              <>
                <strong>Smart</strong> snaps a SAM contour from a single
                click. For multi-prompt refinement (point + box + text),
                use the <strong>SAM (assisted)</strong> section above.
              </>
            ) : (
              <>
                Load a SAM model in the <strong>SAM (assisted)</strong>{' '}
                section above to unlock single-click <strong>Smart</strong>{' '}
                brushing here.
              </>
            )}
          </span>
        </div>
        {mode === 'brush' && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Brush colour
            </div>
            <div className="grid grid-cols-6 gap-1">
              {BRUSH_PALETTE.map((p) => {
                const active = p.label === label;
                const manifestName = labels[p.label];
                const tooltip = manifestName ? `${p.name} · ${manifestName}` : p.name;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setLabel(p.label)}
                    aria-label={tooltip}
                    title={tooltip}
                    className={`relative h-7 w-full rounded border-2 transition ${
                      active
                        ? 'border-tamias-accent ring-2 ring-tamias-accent/30'
                        : 'border-slate-200 hover:border-slate-400'
                    }`}
                    style={{ background: p.color }}
                  />
                );
              })}
            </div>
          </div>
        )}
        <div className="text-[11px] text-slate-500">
          {mode === 'off'
            ? 'Pick Brush, Eraser, or Smart to start correcting.'
            : mode === 'eraser'
              ? 'Drag on a 2D slice to erase.'
              : mode === 'smart'
                ? 'Click anywhere on a 2D slice — SAM will snap a contour around the structure under the cursor.'
                : `Painting in ${BRUSH_PALETTE.find((p) => p.label === label)?.name.toLowerCase() ?? 'colour'}. Strokes appear in 2D + 3D after release.`}
        </div>
        <Badge variant="warn">
          Corrections are visual; the original AI mask is preserved on Save .nii.
        </Badge>
      </CardContent>
    </Card>
  );
}
