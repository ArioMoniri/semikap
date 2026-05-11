import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  createOsdViewer,
  type OsdViewer,
  type DistanceMeasurement,
  type DragMode,
  type MaskOverlay,
} from '../../lib/pathology/osd-viewer';
import { openSlide } from '../../lib/pathology/tilesources/index';
import type { PickedSlide, SlideMetadata } from '../../types';

export interface PathologyViewerHandle {
  loadSlide(slide: PickedSlide): Promise<SlideMetadata>;
  setDragMode(mode: DragMode): void;
  fit(): void;
  oneToOne(): void;
  zoomBy(factor: number): void;
  reset(): void;
  screenshot(): Promise<Blob | null>;
  setMaskOverlay(overlay: MaskOverlay | null): void;
  setBrushLabel(label: number): void;
  setBrushRadius(radius: number): void;
  undoBrush(): void;
  clearBrush(): void;
  getBrushBuffer():
    | ReturnType<OsdViewer['getBrushBuffer']>
    | null;
  /** Listen for distance-tool measurements. Fires once per release event. */
  onMeasure(fn: (m: DistanceMeasurement | null) => void): () => void;
  /** Listen for cursor probe (slide-pixel + mpp). */
  onProbe(
    fn: (p: { px: [number, number]; mpp: [number, number] | null } | null) => void
  ): () => void;
  // ── SAM helpers ──
  /** Read a slide region at level 0 down-sampled to (targetW × targetH).
   *  Used by the pathology SAM panel to grab a 1024² ROI tile. */
  readLevel0Region(
    level0X: number,
    level0Y: number,
    level0W: number,
    level0H: number,
    targetW: number,
    targetH: number
  ): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }>;
  /** Map a canvas-space pointer event to slide level-0 pixel coords.
   *  Returns null when the click is outside the slide. */
  canvasToLevel0(canvasX: number, canvasY: number): { x: number; y: number } | null;
  /** v0.8.14 — inverse: project a level-0 slide pixel back to
   *  viewer-element CSS pixel coords. Used by the SAM prompt overlay
   *  to draw point/box markers + the in-progress box-drag preview
   *  rectangle on top of the OSD canvas. */
  level0ToCanvas(slideX: number, slideY: number): { x: number; y: number } | null;
}

export const PathologyViewer = forwardRef<PathologyViewerHandle>(function PathologyViewer(
  _,
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<OsdViewer | null>(null);

  useEffect(() => {
    return () => {
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    (): PathologyViewerHandle => ({
      async loadSlide(slide) {
        if (!hostRef.current) throw new Error('Viewer not mounted');
        // Tear down any previous viewer instance — OSD doesn't support
        // hot-swapping the tile source on the fly with our custom bridge.
        viewerRef.current?.destroy();
        viewerRef.current = null;

        const loader = await openSlide({ bytes: slide.bytes, filename: slide.name });
        viewerRef.current = createOsdViewer({ element: hostRef.current, loader });
        return loader.meta;
      },
      setDragMode(mode) {
        viewerRef.current?.setDragMode(mode);
      },
      fit() {
        viewerRef.current?.fit();
      },
      oneToOne() {
        viewerRef.current?.oneToOne();
      },
      zoomBy(factor) {
        viewerRef.current?.zoomBy(factor);
      },
      reset() {
        viewerRef.current?.reset();
      },
      async screenshot() {
        return (await viewerRef.current?.screenshot()) ?? null;
      },
      setMaskOverlay(overlay) {
        viewerRef.current?.setMaskOverlay(overlay);
      },
      setBrushLabel(label) {
        viewerRef.current?.setBrushLabel(label);
      },
      setBrushRadius(radius) {
        viewerRef.current?.setBrushRadius(radius);
      },
      undoBrush() {
        viewerRef.current?.undoBrush();
      },
      clearBrush() {
        viewerRef.current?.clearBrush();
      },
      getBrushBuffer() {
        return viewerRef.current?.getBrushBuffer() ?? null;
      },
      onMeasure(fn) {
        if (!viewerRef.current) return () => undefined;
        return viewerRef.current.onMeasure(fn);
      },
      onProbe(fn) {
        if (!viewerRef.current) return () => undefined;
        return viewerRef.current.onProbe(fn);
      },
      async readLevel0Region(level0X, level0Y, level0W, level0H, targetW, targetH) {
        if (!viewerRef.current) {
          throw new Error('No slide loaded');
        }
        return viewerRef.current.readLevel0Region(
          level0X,
          level0Y,
          level0W,
          level0H,
          targetW,
          targetH
        );
      },
      canvasToLevel0(canvasX, canvasY) {
        return viewerRef.current?.canvasToLevel0(canvasX, canvasY) ?? null;
      },
      level0ToCanvas(slideX, slideY) {
        return viewerRef.current?.level0ToCanvas(slideX, slideY) ?? null;
      },
    })
  );

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 bg-black"
      role="img"
      aria-label="Whole-slide image"
    />
  );
});
