// Single-file fallback tile source. Loads a PNG / JPEG / non-pyramidal
// TIFF into one off-screen ImageBitmap and serves OpenSeadragon tiles by
// drawing the corresponding region into a small canvas. Good for the
// bring-your-own thumbnail / lo-res WSI case, capped by browser canvas
// limits (~16 384 px per axis on most engines).
//
// For real WSIs the user wants `OmeTiffTileSource` instead — this loader
// has no pyramid, so zoomed-out views resample the full image every call.

import { decode as decodeTiff } from './tiff-fallback';
import type { SlideMetadata, TileLoader } from '../../../types';

/**
 * Build a single-file tile loader from raw bytes. Format is sniffed from
 * the leading magic bytes — extension is only a hint.
 */
export async function createSingleFileTileLoader(
  bytes: Uint8Array,
  filename: string
): Promise<TileLoader> {
  // TS-5.7+ narrows Uint8Array.buffer to ArrayBufferLike, which Blob's
  // BlobPart no longer accepts. Fall back to a copy when we don't have
  // a plain ArrayBuffer behind the bytes.
  const blob = new Blob(
    bytes.buffer instanceof ArrayBuffer
      ? [bytes as Uint8Array<ArrayBuffer>]
      : [bytes.slice() as unknown as Uint8Array<ArrayBuffer>]
  );
  let bitmap: ImageBitmap;
  try {
    if (isTiff(bytes)) {
      bitmap = await decodeTiff(bytes);
    } else {
      bitmap = await createImageBitmap(blob);
    }
  } catch (e) {
    throw new Error(
      `Failed to decode ${filename}: ${(e as Error).message}. ` +
        `Convert to OME-TIFF (e.g. bioformats2raw + raw2ometiff) for large slides.`
    );
  }

  const meta: SlideMetadata = {
    width: bitmap.width,
    height: bitmap.height,
    mppX: null,
    mppY: null,
    levels: 1,
    downsamples: [1],
    levelDims: [[bitmap.width, bitmap.height]],
    sourceName: filename,
  };

  // Pre-build a backing canvas so every readTile is a fast drawImage.
  // OffscreenCanvas keeps us off the main thread when the loader is
  // instantiated inside a worker; falls back to HTMLCanvasElement on
  // browsers without OffscreenCanvas.
  const bg: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), {
          width: bitmap.width,
          height: bitmap.height,
        });
  const bgCtx = bg.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!bgCtx) throw new Error('Could not acquire 2D context for slide canvas.');
  bgCtx.drawImage(bitmap, 0, 0);

  return {
    meta,
    async readTile(level, col, row, tileSize) {
      if (level !== 0) {
        // Single-file source has no pyramid — same image at every level,
        // so OSD never asks for level > 0.
        throw new Error(`Single-file tile source has no level ${level}.`);
      }
      const x = col * tileSize;
      const y = row * tileSize;
      const w = Math.min(tileSize, bitmap.width - x);
      const h = Math.min(tileSize, bitmap.height - y);
      const data = (bgCtx as CanvasRenderingContext2D).getImageData(x, y, w, h);
      return { width: w, height: h, rgba: data.data };
    },
    async readRegion(x0, y0, w, h, targetW, targetH) {
      const out: OffscreenCanvas | HTMLCanvasElement =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(targetW, targetH)
          : Object.assign(document.createElement('canvas'), {
              width: targetW,
              height: targetH,
            });
      const outCtx = out.getContext('2d') as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!outCtx) throw new Error('Could not acquire 2D context for region read.');
      outCtx.imageSmoothingEnabled = true;
      outCtx.imageSmoothingQuality = 'high';
      outCtx.drawImage(
        bg as CanvasImageSource,
        x0,
        y0,
        w,
        h,
        0,
        0,
        targetW,
        targetH
      );
      const data = (outCtx as CanvasRenderingContext2D).getImageData(
        0,
        0,
        targetW,
        targetH
      );
      return { width: targetW, height: targetH, rgba: data.data };
    },
    dispose() {
      bitmap.close();
    },
  };
}

function isTiff(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // Little-endian TIFF: II*\0  (0x49 0x49 0x2A 0x00)
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
    return true;
  // Big-endian TIFF: MM\0*    (0x4D 0x4D 0x00 0x2A)
  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    return true;
  return false;
}
