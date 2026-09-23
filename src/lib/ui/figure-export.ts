/**
 * Figure export: standalone SVG markup → SVG file or PNG (rasterised at 3×,
 * white background, 300 dpi pHYs tag). Figures are rendered for export with
 * the light figure theme and explicit presentation attributes (no CSS
 * classes/variables), so the SVG opens identically in Illustrator/Inkscape.
 */
import { crc32 } from '../fs/zip';

/** 300 dpi relative to 96 CSS px per inch (≈ 3.1×). */
export const EXPORT_SCALE = 300 / 96;

/** Ensure an XML prolog + SVG namespace on serialised markup. */
export function standaloneSvg(markup: string): string {
  let s = markup.trim();
  if (!/^<svg[^>]*xmlns=/.test(s)) s = s.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${s}\n`;
}

/** Width/height attributes of an SVG string. */
export function svgSize(markup: string): { width: number; height: number } {
  const w = /<svg[^>]*\swidth="([\d.]+)"/.exec(markup);
  const h = /<svg[^>]*\sheight="([\d.]+)"/.exec(markup);
  const vb = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(markup);
  return { width: Number(w?.[1] ?? vb?.[1] ?? 800), height: Number(h?.[1] ?? vb?.[2] ?? 600) };
}

/** Insert (or replace) a pHYs chunk so viewers read the PNG as `dpi`. */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const sig = 8;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ihdrLen = dv.getUint32(sig);
  const afterIhdr = sig + 12 + ihdrLen;
  // drop an existing pHYs
  const parts: Uint8Array[] = [png.subarray(0, afterIhdr)];
  let p = afterIhdr;
  while (p < png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    if (type !== 'pHYs') parts.push(png.subarray(p, p + 12 + len));
    p += 12 + len;
  }
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  cv.setUint32(8, ppm);
  cv.setUint32(12, ppm);
  chunk[16] = 1; // metre
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));
  parts.splice(1, 0, chunk);
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

async function canvasToPng(canvas: HTMLCanvasElement, dpi = 300): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed');
  return setPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
}

/** Rasterise standalone SVG markup to PNG bytes at `scale`× on white. */
export async function svgToPng(markup: string, scale = EXPORT_SCALE): Promise<Uint8Array> {
  const { width, height } = svgSize(markup);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('SVG could not be rasterised'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = Math.round(width * scale);
    c.height = Math.round(height * scale);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await canvasToPng(c, Math.round(96 * scale));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Encode an existing canvas as PNG (white background preserved from the canvas). */
export function canvasPng(canvas: HTMLCanvasElement, dpi = 300): Promise<Uint8Array> {
  return canvasToPng(canvas, dpi);
}

/** File-name-safe slug. */
export function figSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\w.+-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 100);
}
