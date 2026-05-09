// OME-TIFF tile source — the primary pathway for real WSIs.
//
// The strategy:
//   1. Open the file with geotiff.js so we get the raw IFD list.
//   2. Treat each top-level IFD as a candidate pyramid level. Real
//      OME-TIFFs from QuPath / bfconvert / bioformats2raw store the
//      pyramid as a chain of IFDs whose dimensions halve each step;
//      we filter to that monotonic-decreasing chain so any extra IFDs
//      (label, macro thumbnail) don't get treated as pyramid levels.
//   3. Parse the OME-XML in IFD 0's ImageDescription to recover
//      `PhysicalSizeX/Y` (microns per pixel). When the file lacks it
//      we surface mppX/mppY as null and the UI prompts the user.
//   4. readTile reads one tile (or strip) directly from geotiff.js,
//      which honours the on-disk tile geometry. readRegion picks the
//      best level by downsample, reads the rectangle, and resamples
//      to the requested target size.

import { fromArrayBuffer } from 'geotiff';
import type GeoTIFFType from 'geotiff';
import type { SlideMetadata, TileLoader } from '../../../types';

// Structural alias for GeoTIFFImage. The class is exported as the default
// of geotiff's `geotiffimage.d.ts`, but Vite's package-resolution paths
// aren't friendly to deep imports, so we re-declare just the surface we use.
interface TiffFileDirectory {
  ImageDescription?: string;
  /** TIFF resolution tags: pixels per `ResolutionUnit`. Used to derive
   *  MPP for vendor formats that don't expose explicit physical-size XML
   *  (Hamamatsu NDPI, plain pyramidal TIFFs). */
  XResolution?: number | [number, number];
  YResolution?: number | [number, number];
  /** 1 = none, 2 = inch, 3 = centimetre. */
  ResolutionUnit?: number;
}
interface GeoTIFFImage {
  getWidth(): number;
  getHeight(): number;
  getTileWidth(): number;
  getTileHeight(): number;
  getSamplesPerPixel(): number;
  getFileDirectory(): TiffFileDirectory;
  readRasters(options: {
    window?: [number, number, number, number];
    interleave?: boolean;
  }): Promise<unknown>;
}

interface LevelInfo {
  index: number; // index in the original IFD list
  image: GeoTIFFImage;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  samples: number;
  /** Downsample relative to level 0. Always >= 1. */
  downsample: number;
}

/** Build an OME-TIFF tile loader. Errors fast (with an explanatory
 *  message) when the file is not a valid TIFF or the levels can't be
 *  identified. */
export async function createOmeTiffTileLoader(
  bytes: Uint8Array,
  filename: string
): Promise<TileLoader> {
  const buf =
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : (() => {
          const out = new Uint8Array(bytes.byteLength);
          out.set(bytes);
          return out.buffer;
        })();

  let tiff: GeoTIFFType;
  try {
    tiff = await fromArrayBuffer(buf);
  } catch (e) {
    throw new Error(
      `Could not open ${filename} as a TIFF: ${(e as Error).message}.`
    );
  }

  const count = await tiff.getImageCount();
  if (count === 0) {
    throw new Error(`${filename} contains no images.`);
  }

  // First pass: load every IFD's geometry. We only call getImage(i) — no
  // pixel decoding yet, so this is cheap even for 50-level pyramids.
  const all: LevelInfo[] = [];
  for (let i = 0; i < count; i++) {
    const image = (await tiff.getImage(i)) as unknown as GeoTIFFImage;
    const w = image.getWidth();
    const h = image.getHeight();
    if (w === 0 || h === 0) continue;
    all.push({
      index: i,
      image,
      width: w,
      height: h,
      tileWidth: image.getTileWidth() || w,
      tileHeight: image.getTileHeight() || h,
      samples: image.getSamplesPerPixel(),
      downsample: 1, // overwritten below
    });
  }

  if (all.length === 0) {
    throw new Error(`${filename} contains no readable images.`);
  }

  // Second pass: identify the pyramid chain. Sort by area descending,
  // then keep IFDs whose width/height are strictly decreasing (so a
  // tiny label image scattered between levels is dropped). This matches
  // what OpenSlide's `tiff` driver does for plain pyramidal TIFFs.
  const byArea = [...all].sort((a, b) => b.width * b.height - a.width * a.height);
  const levels: LevelInfo[] = [];
  for (const lvl of byArea) {
    if (
      levels.length === 0 ||
      (lvl.width < levels[levels.length - 1]!.width &&
        lvl.height < levels[levels.length - 1]!.height)
    ) {
      levels.push(lvl);
    }
  }
  // Compute downsample relative to level 0.
  const baseW = levels[0]!.width;
  for (const lvl of levels) {
    lvl.downsample = baseW / lvl.width;
  }

  // Parse vendor metadata for MPP. We try, in order:
  //   1. OME-XML PhysicalSizeX/Y (OME-TIFF, QuPath exports, bfconvert)
  //   2. Aperio "MPP = 0.25" string in ImageDescription (.svs)
  //   3. TIFF XResolution/YResolution + ResolutionUnit (Hamamatsu NDPI
  //      and plain pyramidal TIFFs)
  const fd = levels[0]!.image.getFileDirectory();
  const desc = fd.ImageDescription;
  const mpp =
    parseOmeMpp(desc) ?? parseAperioMpp(desc) ?? parseResolutionMpp(fd);
  const vendor = parseVendor(desc, filename);

  const meta: SlideMetadata = {
    width: levels[0]!.width,
    height: levels[0]!.height,
    mppX: mpp?.x ?? null,
    mppY: mpp?.y ?? null,
    levels: levels.length,
    downsamples: levels.map((l) => l.downsample),
    levelDims: levels.map((l) => [l.width, l.height] as [number, number]),
    sourceName: filename,
    ...(vendor ? { vendor } : {}),
  };

  return {
    meta,
    async readTile(level, col, row, tileSize) {
      // OSD asks for tiles at our advertised pyramid levels. The level
      // it passes is "OSD level" (0 = lowest-res). We expose levels in
      // OpenSlide convention (0 = highest-res), so convert.
      const slideLevel = levels.length - 1 - level;
      const lvl = levels[Math.max(0, Math.min(levels.length - 1, slideLevel))];
      if (!lvl) {
        throw new Error(`No pyramid level for OSD level ${level}.`);
      }

      const x = col * tileSize;
      const y = row * tileSize;
      const w = Math.min(tileSize, lvl.width - x);
      const h = Math.min(tileSize, lvl.height - y);
      if (w <= 0 || h <= 0) {
        return { width: 0, height: 0, rgba: new Uint8ClampedArray() };
      }

      const data = (await lvl.image.readRasters({
        window: [x, y, x + w, y + h],
        interleave: true,
      })) as Uint8Array | Uint16Array | Float32Array;

      const rgba = new Uint8ClampedArray(w * h * 4);
      toRgba(data, lvl.samples, rgba);
      return { width: w, height: h, rgba };
    },
    async readRegion(x0, y0, w, h, targetW, targetH) {
      // Pick the level whose downsample ≤ requested downsample. The
      // requested downsample is the larger of (w/targetW, h/targetH);
      // reading from a higher-res-than-needed level just adds work, so
      // we step down to the closest level coarser than that ratio
      // (clamped to level 0 if we're zooming in).
      const requestedDS = Math.max(w / targetW, h / targetH);
      let chosen = 0;
      for (let i = 0; i < levels.length; i++) {
        if (levels[i]!.downsample <= requestedDS) {
          chosen = i;
        } else {
          break;
        }
      }
      const lvl = levels[chosen]!;
      const lx = Math.floor(x0 / lvl.downsample);
      const ly = Math.floor(y0 / lvl.downsample);
      const lw = Math.max(1, Math.ceil(w / lvl.downsample));
      const lh = Math.max(1, Math.ceil(h / lvl.downsample));

      const data = (await lvl.image.readRasters({
        window: [lx, ly, lx + lw, ly + lh],
        interleave: true,
      })) as Uint8Array | Uint16Array | Float32Array;

      const rgba = new Uint8ClampedArray(lw * lh * 4);
      toRgba(data, lvl.samples, rgba);

      // Resample to the requested target size via a 2D canvas.
      if (lw === targetW && lh === targetH) {
        return { width: targetW, height: targetH, rgba };
      }
      const src: OffscreenCanvas | HTMLCanvasElement =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(lw, lh)
          : Object.assign(document.createElement('canvas'), { width: lw, height: lh });
      const srcCtx = src.getContext('2d') as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!srcCtx) throw new Error('Could not acquire 2D context.');
      srcCtx.putImageData(new ImageData(rgba, lw, lh), 0, 0);

      const dst: OffscreenCanvas | HTMLCanvasElement =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(targetW, targetH)
          : Object.assign(document.createElement('canvas'), {
              width: targetW,
              height: targetH,
            });
      const dstCtx = dst.getContext('2d') as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!dstCtx) throw new Error('Could not acquire 2D context.');
      dstCtx.imageSmoothingEnabled = true;
      dstCtx.imageSmoothingQuality = 'high';
      dstCtx.drawImage(src as CanvasImageSource, 0, 0, lw, lh, 0, 0, targetW, targetH);
      const out = (dstCtx as CanvasRenderingContext2D).getImageData(0, 0, targetW, targetH);
      return { width: targetW, height: targetH, rgba: out.data };
    },
    dispose() {
      // geotiff.js doesn't expose an explicit close for ArrayBuffer-backed
      // sources — the buffer is GC'd when nothing references the GeoTIFF
      // instance. Drop the references so it becomes collectible.
      for (const lvl of levels) {
        (lvl as { image: GeoTIFFImage | undefined }).image = undefined;
      void tiff; // keep reference for the closure-bound dispose path
      }
    },
  };
}

// ── Vendor metadata parsing ────────────────────────────────────────────

interface MppPair {
  x: number;
  y: number;
}

/** OME-XML form: produced by QuPath, bfconvert, bioformats2raw, etc. */
function parseOmeMpp(desc: string | undefined): MppPair | null {
  if (!desc) return null;
  const xMatch = /PhysicalSizeX\s*=\s*"([^"]+)"/i.exec(desc);
  const yMatch = /PhysicalSizeY\s*=\s*"([^"]+)"/i.exec(desc);
  if (!xMatch || !yMatch) return null;
  const x = Number(xMatch[1]);
  const y = Number(yMatch[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) {
    return null;
  }
  // Default unit in OME 2016+ is µm; honour an explicit unit when set.
  const xUnit = /PhysicalSizeXUnit\s*=\s*"([^"]+)"/i.exec(desc)?.[1] ?? 'µm';
  const yUnit = /PhysicalSizeYUnit\s*=\s*"([^"]+)"/i.exec(desc)?.[1] ?? 'µm';
  return { x: toMicrons(x, xUnit), y: toMicrons(y, yUnit) };
}

/** Aperio SVS form. ImageDescription is a pipe-delimited blob:
 *    Aperio Image Library v11.2.1 ... |MPP = 0.2492|AppMag = 40|...
 *  The MPP token is in microns per pixel directly. */
function parseAperioMpp(desc: string | undefined): MppPair | null {
  if (!desc || !/aperio/i.test(desc)) return null;
  const m = /\bMPP\s*=\s*([0-9.]+)/i.exec(desc);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return { x: v, y: v };
}

/** Generic TIFF resolution tags. NDPI doesn't carry an OME-XML and
 *  Aperio-style ImageDescription, but it does expose XResolution /
 *  YResolution in pixels per centimetre (ResolutionUnit = 3) which we
 *  invert to microns per pixel. */
function parseResolutionMpp(fd: TiffFileDirectory): MppPair | null {
  const x = readResolution(fd.XResolution);
  const y = readResolution(fd.YResolution);
  if (x === null || y === null) return null;
  // ResolutionUnit: 1 = no absolute unit (skip), 2 = inch, 3 = cm.
  const unit = fd.ResolutionUnit ?? 0;
  let micronsPerUnit: number;
  if (unit === 2) micronsPerUnit = 25400; // 1 inch = 25,400 µm
  else if (unit === 3) micronsPerUnit = 10000; // 1 cm = 10,000 µm
  else return null;
  return {
    x: micronsPerUnit / x,
    y: micronsPerUnit / y,
  };
}

function readResolution(v: number | [number, number] | undefined): number | null {
  if (typeof v === 'number') return v > 0 ? v : null;
  if (Array.isArray(v) && v.length === 2) {
    const [num, den] = v;
    if (typeof num === 'number' && typeof den === 'number' && den > 0) {
      return num / den;
    }
  }
  return null;
}

function toMicrons(v: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case 'µm':
    case 'um':
    case 'micrometer':
    case 'micrometre':
      return v;
    case 'nm':
    case 'nanometer':
    case 'nanometre':
      return v * 0.001;
    case 'mm':
    case 'millimeter':
    case 'millimetre':
      return v * 1000;
    case 'cm':
    case 'centimeter':
    case 'centimetre':
      return v * 10000;
    default:
      return v; // assume µm if unrecognised
  }
}

function parseVendor(desc: string | undefined, filename: string): string | undefined {
  if (desc) {
    if (/aperio/i.test(desc)) return 'Aperio';
    if (/hamamatsu/i.test(desc) || /\bndp(\.|i)/i.test(desc)) return 'Hamamatsu';
    if (/qupath/i.test(desc)) return 'QuPath';
    if (/bioformats/i.test(desc)) return 'Bio-Formats';
  }
  const f = filename.toLowerCase();
  if (f.endsWith('.svs')) return 'Aperio';
  if (f.endsWith('.ndpi')) return 'Hamamatsu';
  return undefined;
}

// ── pixel format conversion (mirror of tiff-fallback.ts) ───────────────

function toRgba(
  src: Uint8Array | Uint16Array | Float32Array,
  samples: number,
  out: Uint8ClampedArray
): void {
  let lo = Infinity;
  let hi = -Infinity;
  if (src instanceof Uint8Array) {
    lo = 0;
    hi = 255;
  } else {
    for (let i = 0; i < src.length; i++) {
      const v = src[i] as number;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi === lo) {
      lo = 0;
      hi = 1;
    }
  }
  const scale = 255 / (hi - lo);
  const npx = out.length / 4;

  if (samples === 1) {
    for (let i = 0; i < npx; i++) {
      const v = Math.max(0, Math.min(255, ((src[i] as number) - lo) * scale));
      out[i * 4] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = 255;
    }
  } else if (samples === 3) {
    for (let i = 0; i < npx; i++) {
      out[i * 4] = Math.max(0, Math.min(255, ((src[i * 3] as number) - lo) * scale));
      out[i * 4 + 1] = Math.max(
        0,
        Math.min(255, ((src[i * 3 + 1] as number) - lo) * scale)
      );
      out[i * 4 + 2] = Math.max(
        0,
        Math.min(255, ((src[i * 3 + 2] as number) - lo) * scale)
      );
      out[i * 4 + 3] = 255;
    }
  } else if (samples === 4) {
    if (src instanceof Uint8Array) {
      out.set(src);
    } else {
      for (let i = 0; i < npx; i++) {
        out[i * 4] = Math.max(0, Math.min(255, ((src[i * 4] as number) - lo) * scale));
        out[i * 4 + 1] = Math.max(
          0,
          Math.min(255, ((src[i * 4 + 1] as number) - lo) * scale)
        );
        out[i * 4 + 2] = Math.max(
          0,
          Math.min(255, ((src[i * 4 + 2] as number) - lo) * scale)
        );
        out[i * 4 + 3] = src[i * 4 + 3] as number;
      }
    }
  } else {
    throw new Error(`Unsupported samples-per-pixel: ${samples}.`);
  }
}
