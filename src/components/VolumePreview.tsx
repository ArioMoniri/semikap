import { useEffect, useRef } from 'react';
import { useAppStore } from '../lib/state/store';

/**
 * Tiny mid-axial-slice thumbnail of the currently loaded volume — like the
 * sidebar previews in OHIF / Horos. Renders the centre Z slice as a small
 * canvas so users can confirm at a glance that the file they picked is the
 * one they expected.
 *
 * Cheap — runs once per volume (no animation, no GL), plain 2D canvas.
 * Honours the volume's actual dtype range via window/level autodetect on
 * the slice itself, so dark CTs and bright MRs both render legibly.
 */
export function VolumePreview() {
  const volume = useAppStore((s) => s.volume);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !volume) return;

    const [X, Y, Z] = volume.meta.dims;
    const z = Math.floor(Z / 2);
    const slab = X * Y;
    const offset = z * slab;
    const src = volume.voxels;

    // Auto-window the centre slice: percentiles 1 and 99 keep extreme
    // outliers (table edges, body markers, MR salt-and-pepper) from washing
    // out the actual anatomy.
    const sliceLen = slab;
    const tmp = new Float32Array(sliceLen);
    for (let i = 0; i < sliceLen; i++) tmp[i] = src[offset + i] ?? 0;
    const sorted = Float32Array.from(tmp).sort();
    const lo = sorted[Math.floor(sliceLen * 0.01)] ?? sorted[0]!;
    const hi = sorted[Math.floor(sliceLen * 0.99)] ?? sorted[sliceLen - 1]!;
    const range = Math.max(1e-6, hi - lo);

    canvas.width = X;
    canvas.height = Y;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(X, Y);
    for (let i = 0; i < sliceLen; i++) {
      const v = ((tmp[i]! - lo) / range) * 255;
      const c = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      const off = i * 4;
      img.data[off] = c;
      img.data[off + 1] = c;
      img.data[off + 2] = c;
      img.data[off + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [volume]);

  if (!volume) return null;

  const [X, Y, Z] = volume.meta.dims;
  return (
    <div className="space-y-1">
      <div className="overflow-hidden rounded border border-slate-300 bg-black dark:border-slate-700">
        <canvas
          ref={canvasRef}
          className="block h-auto w-full"
          aria-label="Mid-axial slice preview of the loaded volume"
        />
      </div>
      <div className="text-[10px] text-slate-500">
        Mid-axial slice {Math.floor(Z / 2) + 1}/{Z} · {X}×{Y}
      </div>
    </div>
  );
}
