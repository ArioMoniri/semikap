// Decode a non-pyramidal TIFF into an ImageBitmap. We use geotiff.js
// because it understands striped + tiled TIFFs and the common compression
// codecs (LZW, JPEG, Deflate). This path is the fallback for plain `.tif`
// files; OME-TIFFs are handled by `ome-tiff.ts` which actually walks the
// pyramid.

import { fromArrayBuffer } from 'geotiff';

export async function decode(bytes: Uint8Array): Promise<ImageBitmap> {
  // geotiff.js wants a non-shared ArrayBuffer. Copy when the source
  // sits on a SharedArrayBuffer (e.g. when called from a COI worker).
  const buf =
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : (() => {
          const out = new Uint8Array(bytes.byteLength);
          out.set(bytes);
          return out.buffer;
        })();

  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const samplesPerPixel = image.getSamplesPerPixel();

  const raster = (await image.readRasters({ interleave: true })) as
    | Uint8Array
    | Uint16Array
    | Float32Array;

  const rgba = new Uint8ClampedArray(width * height * 4);
  toRgba(raster, samplesPerPixel, rgba);

  // ImageData → ImageBitmap so single-file.ts can drawImage it.
  const imgData = new ImageData(rgba, width, height);
  return createImageBitmap(imgData);
}

function toRgba(
  src: Uint8Array | Uint16Array | Float32Array,
  samples: number,
  out: Uint8ClampedArray
): void {
  // Find the dynamic range so 16-bit / float TIFFs land in 0..255 with a
  // sensible window. Cheap two-pass: max / min, then linear scale.
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
