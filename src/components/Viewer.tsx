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
    opacity?: number
  ): Promise<void>;
  removeMaskOverlay(): void;
  setMaskOpacity(opacity: number): void;
  setMaskColormap(colormap: OverlayColorMap): void;
  setWindow(level: number, width: number): void;
  setDrawingEnabled(on: boolean): void;
  setBrushLabel(label: number): void;
  undoLastBrushStroke(): void;
  /** Returns the AI mask merged with any user brush corrections, or null
   *  when no corrections have been drawn. */
  getCorrectedMask(aiMask: Uint8Array): Uint8Array | null;
  onProbe(listener: (r: ProbeReading | null) => void): () => void;
}

export const Viewer = forwardRef<ViewerHandle>(function Viewer(_, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<NiivueViewer | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    viewerRef.current = new NiivueViewer(canvasRef.current);
    const onResize = () => viewerRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
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
      async addMaskOverlay(name, mask, dims, spacing, colormap, opacity) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        await viewerRef.current.addMaskOverlay(name, mask, dims, spacing, colormap, opacity);
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
      undoLastBrushStroke() {
        viewerRef.current?.undoLastBrushStroke();
      },
      getCorrectedMask(aiMask) {
        return viewerRef.current?.getCorrectedMask(aiMask) ?? null;
      },
      onProbe(listener) {
        if (!viewerRef.current) return () => undefined;
        return viewerRef.current.onProbe(listener);
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
