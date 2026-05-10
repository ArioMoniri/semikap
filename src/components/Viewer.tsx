import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { NiivueViewer, type OverlayColorMap, type ProbeReading, type AngleState } from '../lib/viewer/niivue';
import type { Bytes, VolumeMetadata } from '../types';

export type { ProbeReading };

export interface LoadedFromViewer {
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  meta: VolumeMetadata;
}

export interface ViewerHandle {
  loadPrimary(name: string, bytes: Bytes): Promise<LoadedFromViewer>;
  loadSecondary(name: string, bytes: Bytes, opacity?: number, colormap?: OverlayColorMap): Promise<LoadedFromViewer>;
  removeSecondary(): void;
  addMaskOverlay(
    name: string,
    mask: Uint8Array,
    dims: [number, number, number],
    spacing: [number, number, number],
    colormap?: OverlayColorMap,
    opacity?: number,
    affine?: {
      srowX?: [number, number, number, number];
      srowY?: [number, number, number, number];
      srowZ?: [number, number, number, number];
      origin?: [number, number, number];
    }
  ): Promise<void>;
  removeMaskOverlay(): void;
  setMaskOpacity(opacity: number): void;
  setMaskColormap(colormap: OverlayColorMap): void;
  setWindow(level: number, width: number): void;
  setDrawingEnabled(on: boolean): void;
  setBrushLabel(label: number): void;
  setBrushOpacity(opacity: number): void;
  /** Brush radius in voxels (1..30). Applies to both brush + eraser. */
  setBrushRadius(radius: number): void;
  /** Wipe every painted voxel; subsequent strokes still work. */
  clearAllBrushStrokes(): void;
  /** Push current draw bitmap into the 3D mesh + redraw. Call on pointerup
   *  so the user's brush strokes appear in the volumetric render, not
   *  just the 2D MPR slices. */
  refreshDrawing(): void;
  /** Unconditional re-paint (no draw-mesh update). Used by the recovery
   *  handlers in this component so the canvas can repaint after WebGL
   *  context loss / cursor-leave even when the brush isn't active. */
  redraw(): void;
  undoLastBrushStroke(): void;
  /** Returns the AI mask merged with any user brush corrections, or null
   *  when no corrections have been drawn. */
  getCorrectedMask(aiMask: Uint8Array): Uint8Array | null;
  /** Returns the raw user brush layer (label per voxel; 0 = unpainted) so
   *  callers can split it by colour for per-label export. */
  getDrawnLayer(): Uint8Array | null;
  onProbe(listener: (r: ProbeReading | null) => void): () => void;
  // ── Layout / chrome ──
  setSliceMode(mode: 'multi' | 'axial' | 'coronal' | 'sagittal' | 'render'): void;
  setMultiplanarLayout(layout: 'auto' | 'column' | 'grid' | 'row'): void;
  setOrientCube(on: boolean): void;
  setColorbar(on: boolean): void;
  set3DCrosshair(on: boolean): void;
  setRadiologicalConvention(on: boolean): void;
  // ── Radiology tools ──
  setDragMode(mode: 'none' | 'contrast' | 'measurement' | 'pan'): void;
  setMaskOutlineOnly(on: boolean): void;
  resetView(): void;
  zoomBy(factor: number): void;
  /** Capture the canvas as a PNG; null when the GL context isn't ready. */
  takeScreenshot(): Promise<Blob | null>;
  // ── Angle measurement (3-click) ──
  setAngleMode(on: boolean): void;
  isAngleMode(): boolean;
  addAnglePoint(mm: [number, number, number]): void;
  clearAnglePoints(): void;
  onAngleUpdate(cb: (state: AngleState) => void): () => void;
  // ── SAM helpers ──
  /** Pull the current axial slice as Float32 grayscale + dims, for SAM
   *  encoding. Returns null when no primary volume is loaded. */
  getCurrentAxialSlice(): { pixels: Float32Array; width: number; height: number; index: number } | null;
  /** Same as getCurrentAxialSlice() but for a specific axial index. Used
   *  by SAM Phase D cross-slice propagation. Returns null when z is out
   *  of bounds or no primary volume is loaded. */
  getAxialSliceAt(
    z: number
  ): { pixels: Float32Array; width: number; height: number; index: number } | null;
  /** Map a click in canvas coords (relative to the overlay rect, which
   *  matches the canvas position) to source-axial-slice voxel coords.
   *  Returns null when the click is outside any slice tile. */
  canvasToAxialVoxel(canvasX: number, canvasY: number): { x: number; y: number } | null;
}

export const Viewer = forwardRef<ViewerHandle>(function Viewer(_, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<NiivueViewer | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    viewerRef.current = new NiivueViewer(canvasRef.current);
    const onResize = () => viewerRef.current?.resize();
    window.addEventListener('resize', onResize);

    // Auto-refresh the 3D draw mesh after every brush stroke. NiiVue paints
    // straight into the 2D MPRs as the user drags but doesn't propagate to
    // the volumetric raycaster until refreshDrawing() runs. Tying that to
    // pointerup keeps the 3D view in lockstep without spamming a refresh on
    // every move event (which would tank framerate).
    const canvas = canvasRef.current;

    // Cache the most recent probe reading so the angle tool can capture
    // mm coordinates on pointerup without re-reading NiiVue's scene state.
    let lastMm: [number, number, number] | null = null;
    const probeUnsub = viewerRef.current?.onProbe((reading) => {
      lastMm = reading ? reading.mm : null;
    });

    const onPointerUp = (e: PointerEvent) => {
      // Brush propagation to 3D mesh.
      viewerRef.current?.refreshDrawing();
      // Angle measurement: only LEFT-button pointerups (e.button === 0)
      // count as angle-vertex captures. v0.7.2 captured every button so
      // a right-mouse W/L drag dropped a stray angle vertex on release;
      // worse, it made W/L feel "stuck" because the angle tool also
      // reset some internal state. Restricting to button 0 keeps the
      // right-drag W/L behaviour live while Angle is selected.
      if (
        e.button === 0 &&
        viewerRef.current?.isAngleMode() &&
        lastMm
      ) {
        viewerRef.current.addAnglePoint(lastMm);
      }
    };
    canvas.addEventListener('pointerup', onPointerUp);

    // Defensive recovery for v0.7.0 user reports of "viewer blanks when I use
    // a tool or right-click". On macOS WKWebView (Tauri) the WebGL context
    // can be evicted under memory pressure (large CT + 3D render + concurrent
    // SAM encoder); without explicit handling the canvas just stays at
    // backColor until the user reloads. Catching `webglcontextlost` lets us
    // suppress the default "permanent loss" behaviour, then `restored` calls
    // `drawScene()` so the volumes re-upload textures and the canvas repaints.
    const onContextLost = (e: Event) => {
      e.preventDefault(); // tells the browser the context is recoverable
      // eslint-disable-next-line no-console
      console.warn('[TAMIAS] WebGL context lost — will restore on next event');
    };
    const onContextRestored = () => {
      // eslint-disable-next-line no-console
      console.info('[TAMIAS] WebGL context restored — repainting');
      viewerRef.current?.redraw();
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);

    // Belt-and-suspenders: on `pointerleave` we trigger a no-op redraw
    // pass. NiiVue 0.44.x sometimes leaves the GL state in a configuration
    // where the next hover-redraw clears the canvas to backColor (the
    // v0.5.4 cursor-leave-blanks bug). Re-issuing drawScene() on leave
    // forces a fresh paint so the volumes stay visible until the user
    // re-enters the canvas.
    const onPointerLeave = () => {
      // Defer one frame so any in-flight pointer handler completes first.
      requestAnimationFrame(() => viewerRef.current?.redraw());
    };
    canvas.addEventListener('pointerleave', onPointerLeave);

    return () => {
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerup', onPointerUp);
      probeUnsub?.();
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      canvas.removeEventListener('webglcontextrestored', onContextRestored, false);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      async loadPrimary(name, bytes) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        return viewerRef.current.loadPrimaryFromBytes(name, bytes);
      },
      async loadSecondary(name, bytes, opacity, colormap) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        return viewerRef.current.loadSecondaryFromBytes(name, bytes, opacity, colormap);
      },
      removeSecondary() {
        viewerRef.current?.removeSecondary();
      },
      async addMaskOverlay(name, mask, dims, spacing, colormap, opacity, affine) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        await viewerRef.current.addMaskOverlay(name, mask, dims, spacing, colormap, opacity, affine);
      },
      removeMaskOverlay() {
        viewerRef.current?.removeMaskOverlay();
      },
      setMaskOpacity(opacity) {
        viewerRef.current?.setMaskOpacity(opacity);
      },
      setMaskColormap(colormap) {
        viewerRef.current?.setMaskColormap(colormap);
      },
      setWindow(level, width) {
        viewerRef.current?.setWindow(level, width);
      },
      setDrawingEnabled(on) {
        viewerRef.current?.setDrawingEnabled(on);
      },
      setBrushLabel(label) {
        viewerRef.current?.setBrushLabel(label);
      },
      setBrushOpacity(opacity) {
        viewerRef.current?.setBrushOpacity(opacity);
      },
      setBrushRadius(radius) {
        viewerRef.current?.setBrushRadius(radius);
      },
      clearAllBrushStrokes() {
        viewerRef.current?.clearAllBrushStrokes();
      },
      refreshDrawing() {
        viewerRef.current?.refreshDrawing();
      },
      redraw() {
        viewerRef.current?.redraw();
      },
      undoLastBrushStroke() {
        viewerRef.current?.undoLastBrushStroke();
      },
      getCorrectedMask(aiMask) {
        return viewerRef.current?.getCorrectedMask(aiMask) ?? null;
      },
      getDrawnLayer() {
        return viewerRef.current?.getDrawnLayer() ?? null;
      },
      onProbe(listener) {
        if (!viewerRef.current) return () => undefined;
        return viewerRef.current.onProbe(listener);
      },
      setSliceMode(mode) {
        viewerRef.current?.setSliceMode(mode);
      },
      setMultiplanarLayout(layout) {
        viewerRef.current?.setMultiplanarLayout(layout);
      },
      setOrientCube(on) {
        viewerRef.current?.setOrientCube(on);
      },
      setColorbar(on) {
        viewerRef.current?.setColorbar(on);
      },
      set3DCrosshair(on) {
        viewerRef.current?.set3DCrosshair(on);
      },
      setRadiologicalConvention(on) {
        viewerRef.current?.setRadiologicalConvention(on);
      },
      setDragMode(mode) {
        viewerRef.current?.setDragMode(mode);
      },
      setMaskOutlineOnly(on) {
        viewerRef.current?.setMaskOutlineOnly(on);
      },
      resetView() {
        viewerRef.current?.resetView();
      },
      zoomBy(factor) {
        viewerRef.current?.zoomBy(factor);
      },
      async takeScreenshot() {
        return (await viewerRef.current?.takeScreenshot()) ?? null;
      },
      setAngleMode(on) {
        viewerRef.current?.setAngleMode(on);
      },
      isAngleMode() {
        return viewerRef.current?.isAngleMode() ?? false;
      },
      addAnglePoint(mm) {
        viewerRef.current?.addAnglePoint(mm);
      },
      clearAnglePoints() {
        viewerRef.current?.clearAnglePoints();
      },
      onAngleUpdate(cb) {
        if (!viewerRef.current) return () => undefined;
        return viewerRef.current.onAngleUpdate(cb);
      },
      getCurrentAxialSlice() {
        return viewerRef.current?.getCurrentAxialSlice() ?? null;
      },
      getAxialSliceAt(z) {
        return viewerRef.current?.getAxialSliceAt(z) ?? null;
      },
      canvasToAxialVoxel(x, y) {
        return viewerRef.current?.canvasToAxialVoxel(x, y) ?? null;
      },
    }),
    []
  );

  return (
    <div className="relative h-full w-full bg-black">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
});
