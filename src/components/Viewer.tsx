import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { NiivueViewer } from '../lib/viewer/niivue';
import type { Bytes } from '../types';

export interface ViewerHandle {
  loadVolumeFromBytes(name: string, bytes: Bytes): Promise<{
    voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
    meta: { dims: [number, number, number]; spacing: [number, number, number]; origin: [number, number, number]; dtype: 'int16' | 'uint16' | 'int32' | 'float32' | 'uint8' };
  }>;
  addMaskOverlay(
    name: string,
    mask: Uint8Array,
    dims: [number, number, number],
    spacing: [number, number, number]
  ): Promise<void>;
  removeOverlays(): void;
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
    () => ({
      async loadVolumeFromBytes(name, bytes) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        return viewerRef.current.loadVolumeFromBytes(name, bytes);
      },
      async addMaskOverlay(name, mask, dims, spacing) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        await viewerRef.current.addMaskOverlay(name, mask, dims, spacing);
      },
      removeOverlays() {
        viewerRef.current?.removeOverlays();
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
