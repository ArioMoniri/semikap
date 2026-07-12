/**
 * Render a categorical mask-difference slice (from `lib/metrics/mask-diff`) as a
 * colour-coded 2D image with a legend. Values:
 *   1 both agree · 2 only A · 3 only B · 0 neither (transparent).
 *
 * Purely presentational: it paints the `DiffSlice.pixels` onto a canvas scaled
 * to fit. Used by the batch runner ("view one" preview) and the analysis panel.
 */

import { useEffect, useRef } from 'react';
import type { DiffSlice } from '../lib/metrics/mask-diff';

/** RGBA for each diff category (0 neither is left transparent). */
const COLORS: Record<number, [number, number, number, number]> = {
  1: [52, 211, 153, 235], // emerald — agreement
  2: [56, 189, 248, 235], // sky blue — only A
  3: [244, 114, 182, 235], // pink — only B
};

interface Props {
  slice: DiffSlice | null;
  /** Label for model A (colours the "only A" legend chip). */
  labelA?: string;
  labelB?: string;
  /** Max rendered edge in CSS px (image is nearest-neighbour scaled). */
  maxEdge?: number;
}

export function MaskDiffCanvas({ slice, labelA = 'Model A', labelB = 'Model B', maxEdge = 220 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !slice) return;
    const { width, height, pixels } = slice;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < pixels.length; i++) {
      const v = pixels[i]!;
      const c = COLORS[v];
      const o = i * 4;
      if (c) {
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = c[3];
      } else {
        img.data[o + 3] = 0; // background transparent
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [slice]);

  if (!slice) {
    return <div className="text-slate-400">No overlap slice to preview.</div>;
  }

  const scale = Math.min(maxEdge / slice.width, maxEdge / slice.height, 4);
  const cssW = Math.round(slice.width * scale);
  const cssH = Math.round(slice.height * scale);

  return (
    <div className="space-y-1">
      <div className="inline-block rounded border border-slate-200 bg-slate-900 dark:border-slate-700">
        <canvas
          ref={ref}
          style={{ width: cssW, height: cssH, imageRendering: 'pixelated', display: 'block' }}
        />
      </div>
      <div className="flex flex-wrap gap-2 text-[10px] text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: 'rgb(52,211,153)' }} /> agree
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: 'rgb(56,189,248)' }} /> only {labelA}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: 'rgb(244,114,182)' }} /> only {labelB}
        </span>
        <span>· axial z={slice.z} · {slice.disagreeCount} disagreeing px</span>
      </div>
    </div>
  );
}
