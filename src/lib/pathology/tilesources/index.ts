// Tile-source dispatcher. Picks the right loader for the user's slide
// based on the sniffed format. Vendor formats (SVS, NDPI) currently fall
// through to a clear error directing the user to convert via bfconvert /
// QuPath; native OpenSlide-WASM is roadmapped (see docs/PATHOLOGY.md).

import { detectPathologyFormat } from '../../../types';
import type { PathologyFormat, TileLoader } from '../../../types';
import { createOmeTiffTileLoader } from './ome-tiff';
import { createSingleFileTileLoader } from './single-file';

export interface OpenSlideArgs {
  bytes: Uint8Array;
  filename: string;
}

/**
 * Pick + open a tile loader. SVS and NDPI files are TIFF variants under
 * the hood, so they route through the same pyramidal-TIFF path as
 * OME-TIFF; vendor-specific MPP parsing happens inside `ome-tiff.ts`
 * (Aperio "MPP =" token, Hamamatsu XResolution/YResolution).
 *
 * The vendor path can still fail on a small subset of slides — most
 * commonly NDPI files larger than 4 GB, which use a Hamamatsu-specific
 * 64-bit offset extension that `geotiff.js` doesn't read. We surface a
 * clear conversion error in that case rather than corrupting the read.
 */
export async function openSlide({ bytes, filename }: OpenSlideArgs): Promise<TileLoader> {
  const format = detectPathologyFormat(filename);
  switch (format) {
    case 'ome-tiff':
    case 'tiff':
      try {
        return await createOmeTiffTileLoader(bytes, filename);
      } catch (e) {
        // Fall back to a non-pyramidal decode rather than failing
        // outright — small TIFFs that geotiff.js can't read as a
        // pyramid may still be readable as a single image.
        if (format === 'tiff') {
          return await createSingleFileTileLoader(bytes, filename);
        }
        throw e;
      }
    case 'png':
    case 'jpeg':
      return createSingleFileTileLoader(bytes, filename);
    case 'svs':
    case 'ndpi':
      try {
        return await createOmeTiffTileLoader(bytes, filename);
      } catch (e) {
        throw vendorFallbackError(format, filename, (e as Error).message);
      }
    default:
      throw new Error(
        `Unsupported pathology file format for ${filename}. ` +
          `Supported: OME-TIFF (.ome.tif), TIFF (.tif), Aperio SVS (.svs), ` +
          `Hamamatsu NDPI (.ndpi), PNG, JPEG.`
      );
  }
}

function vendorFallbackError(
  format: 'svs' | 'ndpi',
  filename: string,
  cause: string
): Error {
  // SVS and NDPI usually open through the TIFF path. When they don't,
  // the user is on a Hamamatsu file with the >4 GB NDP_OFFSET_HIGH
  // extension, a JPEG2000-encoded SVS, or a corrupt slide. We surface
  // the bfconvert recipe so the user can recover.
  const vendor = format === 'svs' ? 'Aperio SVS' : 'Hamamatsu NDPI';
  return new Error(
    `${vendor} file ${filename} could not be opened directly: ${cause}\n\n` +
      `This usually means the slide uses a vendor extension that the ` +
      `in-browser TIFF reader doesn't handle (NDPI > 4 GB, JPEG2000, etc.). ` +
      `Convert it offline:\n\n` +
      `  bioformats2raw "${filename}" out.zarr && raw2ometiff out.zarr "${filename}.ome.tif"\n\n` +
      `Or open the slide in QuPath and choose File → Export → OME-TIFF.`
  );
}

export type { PathologyFormat };
