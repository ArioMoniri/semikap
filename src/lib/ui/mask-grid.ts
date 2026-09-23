/** Publication PNG composition of mask-comparison tiles (canvas; white background, captions, R/L markers). */

export interface GridTile {
  canvas: HTMLCanvasElement;
  title: string;
  subtitle?: string;
}

/**
 * Publication PNG canvas of mask tiles: white background, captions above each
 * tile, tiles upscaled (nearest neighbour) to at least `minTile` px, optional
 * header and footer legend. Used for the whole grid and for single tiles.
 */
export function composeGridCanvas(
  tiles: GridTile[],
  opts: { cols?: number; header?: string; footer?: string; minTile?: number } = {}
): HTMLCanvasElement {
  const cols = Math.max(1, Math.min(opts.cols ?? 5, tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const w0 = tiles[0]?.canvas.width ?? 256;
  const h0 = tiles[0]?.canvas.height ?? 256;
  const scale = Math.max(1, Math.ceil((opts.minTile ?? 600) / w0));
  const tw = w0 * scale;
  const th = h0 * scale;
  const fs = Math.max(12, Math.round(tw / 22));
  const cap = Math.round(fs * 2.7);
  const gap = Math.round(fs * 0.9);
  const head = opts.header ? Math.round(fs * 2) : 0;
  const foot = opts.footer ? Math.round(fs * 2.2) : 0;
  const c = document.createElement('canvas');
  c.width = cols * tw + (cols + 1) * gap;
  c.height = head + rows * (th + cap) + (rows + 1) * gap + foot;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = false;
  const font = (px: number, bold = false) => `${bold ? '600 ' : ''}${px}px Helvetica, Arial, sans-serif`;
  if (opts.header) {
    ctx.fillStyle = '#111827';
    ctx.textAlign = 'left';
    ctx.font = font(Math.round(fs * 1.1), true);
    ctx.fillText(opts.header, gap, head - Math.round(fs * 0.4));
  }
  tiles.forEach((t, i) => {
    const x = gap + (i % cols) * (tw + gap);
    const y = head + gap + Math.floor(i / cols) * (th + cap + gap);
    ctx.fillStyle = '#111827';
    ctx.font = font(fs, true);
    ctx.textAlign = 'center';
    ctx.fillText(t.title, x + tw / 2, y + fs);
    if (t.subtitle) {
      ctx.font = font(Math.round(fs * 0.85));
      ctx.fillStyle = '#4b5563';
      ctx.fillText(t.subtitle, x + tw / 2, y + fs * 2.2);
    }
    ctx.drawImage(t.canvas, x, y + cap, tw, th);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(Math.round(fs * 0.8), true);
    ctx.textAlign = 'left';
    ctx.fillText('R', x + fs * 0.4, y + cap + fs);
    ctx.textAlign = 'right';
    ctx.fillText('L', x + tw - fs * 0.4, y + cap + fs);
  });
  if (opts.footer) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#4b5563';
    ctx.font = font(Math.round(fs * 0.8));
    ctx.fillText(opts.footer, gap, c.height - Math.round(fs * 0.7));
  }
  return c;
}

