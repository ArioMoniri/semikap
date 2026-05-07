import { Niivue, NVImage } from '@niivue/niivue';
import type { Bytes, VolumeMetadata } from '../../types';
import { writeNifti1Uint8 } from '../export/nifti';

/**
 * Thin wrapper around NiiVue that:
 *  - mounts the renderer onto a <canvas>
 *  - loads a volume from raw bytes (DICOM/NIfTI/NRRD/MHA detection by extension)
 *  - exposes a simple addOverlay() for showing AI-produced label masks
 *  - extracts canonical voxel data + metadata for the inference pipeline
 */
export interface LoadedVolume {
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  meta: VolumeMetadata;
}

export class NiivueViewer {
  private nv: Niivue;

  constructor(canvas: HTMLCanvasElement) {
    this.nv = new Niivue({
      backColor: [0.04, 0.07, 0.12, 1],
      crosshairColor: [0.95, 0.6, 0.1, 1],
      show3Dcrosshair: true,
      isOrientCube: false,
      multiplanarForceRender: true,
    });
    void this.nv.attachToCanvas(canvas);
  }

  /**
   * Load a volume from bytes. The file name is used to pick the loader and
   * must include the extension (e.g. "scan.nii.gz", "case.nrrd", "img.mha").
   */
  async loadVolumeFromBytes(name: string, bytes: Bytes): Promise<LoadedVolume> {
    // Drop existing volumes before loading the new one.
    while (this.nv.volumes.length > 0) {
      const v = this.nv.volumes[0];
      if (!v) break;
      this.nv.removeVolume(v);
    }

    const image = await NVImage.loadFromUrl({
      url: URL.createObjectURL(new Blob([bytes as BlobPart])),
      name,
    });
    this.nv.addVolume(image);
    this.nv.updateGLVolume();

    const hdr = image.hdr as
      | {
          dims: number[];
          pixDims: number[];
          datatypeCode: number;
          qoffset_x?: number;
          qoffset_y?: number;
          qoffset_z?: number;
        }
      | undefined;
    const dims: [number, number, number] = hdr
      ? [hdr.dims[1] ?? 1, hdr.dims[2] ?? 1, hdr.dims[3] ?? 1]
      : [
          (image as { dimsRAS?: number[] }).dimsRAS?.[1] ?? 1,
          (image as { dimsRAS?: number[] }).dimsRAS?.[2] ?? 1,
          (image as { dimsRAS?: number[] }).dimsRAS?.[3] ?? 1,
        ];
    const spacing: [number, number, number] = hdr
      ? [hdr.pixDims[1] ?? 1, hdr.pixDims[2] ?? 1, hdr.pixDims[3] ?? 1]
      : [1, 1, 1];
    const origin: [number, number, number] = hdr
      ? [hdr.qoffset_x ?? 0, hdr.qoffset_y ?? 0, hdr.qoffset_z ?? 0]
      : [0, 0, 0];

    const img = image.img;
    if (!img) {
      throw new Error('NiiVue produced no voxel data for this volume.');
    }
    const dtype = inferDtype(img);
    const voxels = img as
      | Int16Array
      | Uint16Array
      | Int32Array
      | Uint8Array
      | Float32Array;

    return {
      voxels,
      meta: { dims, spacing, origin, dtype },
    };
  }

  /**
   * Overlay a label mask on top of the loaded volume. The mask must match
   * the source volume's voxel grid exactly.
   */
  async addMaskOverlay(
    name: string,
    mask: Uint8Array,
    dims: [number, number, number],
    spacing: [number, number, number],
    colorMap: 'red' | 'green' | 'blue' | 'roi_i256' = 'red'
  ): Promise<void> {
    if (this.nv.volumes.length === 0) {
      throw new Error('No base volume loaded; cannot overlay a mask.');
    }
    // Build a NIfTI byte-blob for NiiVue to consume — it expects an
    // image-like object, not a raw typed array.
    const nifti = writeNifti1Uint8({ mask, dims, spacing });
    const overlay = await NVImage.loadFromUrl({
      url: URL.createObjectURL(new Blob([nifti as BlobPart])),
      name,
      colormap: colorMap,
      opacity: 0.55,
    });
    this.nv.addVolume(overlay);
    this.nv.updateGLVolume();
  }

  removeOverlays(): void {
    while (this.nv.volumes.length > 1) {
      const v = this.nv.volumes[this.nv.volumes.length - 1];
      if (!v) break;
      this.nv.removeVolume(v);
    }
    this.nv.updateGLVolume();
  }

  resize(): void {
    this.nv.resizeListener();
  }

  destroy(): void {
    while (this.nv.volumes.length > 0) {
      const v = this.nv.volumes[0];
      if (!v) break;
      this.nv.removeVolume(v);
    }
  }
}

function inferDtype(arr: ArrayBufferView): VolumeMetadata['dtype'] {
  if (arr instanceof Int16Array) return 'int16';
  if (arr instanceof Uint16Array) return 'uint16';
  if (arr instanceof Int32Array) return 'int32';
  if (arr instanceof Float32Array) return 'float32';
  return 'uint8';
}
