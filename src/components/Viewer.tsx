import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { NiivueViewer, type OverlayColorMap, type ProbeReading } from '../lib/viewer/niivue';
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
  /** Push current draw bitmap into the 3D mesh + redraw. Call on pointerup
   *  so the user'\''s brush strokes appear in the volumetric render, not
   *  just the 2D MPR slices. */
  refreshDrawing(): void;
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
    // straight into the 2D MPRs as the user drags but doesn'\''t propagate to
    // the volumetric raycaster until refreshDrawing() runs. Tying that to
    // pointerup keeps the 3D view in lockstep without spamming a refresh on
    // every move event (which would tank framerate).
    const canvas = canvasRef.current;
    const onPointerUp = () => viewerRef.current?.refreshDrawing();
    canvas.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerup', onPointerUp);
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
      refreshDrawing() {
        viewerRef.current?.refreshDrawing();
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
    }),
    []
  );

  return (
    <div className="relative h-full w-full bg-black">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
});
