import { Niivue, NVImage } from '@niivue/niivue';
import type { Bytes, VolumeMetadata } from '../../types';
import { writeNifti1Uint8 } from '../export/nifti';

/**
 * Thin wrapper around NiiVue. Responsibilities:
 *   - Mount the renderer onto a <canvas>
 *   - Load a primary volume from raw bytes (DICOM/NIfTI/NRRD/MHA detection by extension)
 *   - Load a secondary volume as a registered overlay (multi-modal display)
 *   - Show AI segmentation masks
 *   - Expose window/level + overlay opacity controls
 *   - Expose a brush/eraser draw layer for clinician correction
 *   - Extract canonical voxel data + metadata for the inference pipeline
 */
export interface LoadedVolume {
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  meta: VolumeMetadata;
}

export type OverlayColorMap = 'red' | 'green' | 'blue' | 'roi_i256';

interface NVImageHeader {
  dims: number[];
  pixDims: number[];
  datatypeCode: number;
  qoffset_x?: number;
  qoffset_y?: number;
  qoffset_z?: number;
}

interface NVDriver {
  drawingEnabled: boolean;
  setPenValue(label: number, isFilledPen?: boolean): void;
  drawUndo(): void;
  closeDrawing(): void;
}

export class NiivueViewer {
  private nv: Niivue;
  /** Index in this.nv.volumes of the primary volume (always 0 once loaded). */
  private primaryIndex = -1;
  /** Index of the secondary base volume (if any). */
  private secondaryIndex = -1;
  /** Index of the segmentation overlay (if any). */
  private maskIndex = -1;

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
   * Load the primary volume. Drops every existing volume — including any
   * secondary or mask layers — so the viewer state is always consistent.
   */
  async loadPrimaryFromBytes(name: string, bytes: Bytes): Promise<LoadedVolume> {
    while (this.nv.volumes.length > 0) {
      const v = this.nv.volumes[0];
      if (!v) break;
      this.nv.removeVolume(v);
    }
    this.primaryIndex = -1;
    this.secondaryIndex = -1;
    this.maskIndex = -1;

    const image = await NVImage.loadFromUrl({
      url: URL.createObjectURL(new Blob([bytes as BlobPart])),
      name,
    });
    this.nv.addVolume(image);
    this.nv.updateGLVolume();
    this.primaryIndex = 0;

    return extractVolume(image);
  }

  /**
   * Add a secondary base volume (e.g. PET on top of CT, T2 on top of T1).
   * Replaces any prior secondary.
   */
  async loadSecondaryFromBytes(
    name: string,
    bytes: Bytes,
    opacity = 0.5,
    colormap: OverlayColorMap = 'red'
  ): Promise<LoadedVolume> {
    if (this.primaryIndex < 0) {
      throw new Error('Load a primary volume before adding a secondary.');
    }
    if (this.secondaryIndex >= 0) {
      const v = this.nv.volumes[this.secondaryIndex];
      if (v) this.nv.removeVolume(v);
      this.secondaryIndex = -1;
      // Removing a volume shifts indices.
      if (this.maskIndex > 0) this.maskIndex -= 1;
    }
    const image = await NVImage.loadFromUrl({
      url: URL.createObjectURL(new Blob([bytes as BlobPart])),
      name,
      opacity,
      colormap,
    });
    this.nv.addVolume(image);
    this.secondaryIndex = this.nv.volumes.length - 1;
    if (this.maskIndex >= 0 && this.maskIndex < this.secondaryIndex) {
      // mask was added before secondary; nothing to update
    }
    this.nv.updateGLVolume();
    return extractVolume(image);
  }

  removeSecondary(): void {
    if (this.secondaryIndex < 0) return;
    const v = this.nv.volumes[this.secondaryIndex];
    if (v) this.nv.removeVolume(v);
    if (this.maskIndex > this.secondaryIndex) this.maskIndex -= 1;
    this.secondaryIndex = -1;
    this.nv.updateGLVolume();
  }

  async addMaskOverlay(
    name: string,
    mask: Uint8Array,
    dims: [number, number, number],
    spacing: [number, number, number],
    colorMap: OverlayColorMap = 'red',
    opacity = 0.55
  ): Promise<void> {
    if (this.primaryIndex < 0) {
      throw new Error('No base volume loaded; cannot overlay a mask.');
    }
    if (this.maskIndex >= 0) {
      const v = this.nv.volumes[this.maskIndex];
      if (v) this.nv.removeVolume(v);
      this.maskIndex = -1;
    }
    const nifti = writeNifti1Uint8({ mask, dims, spacing });
    const overlay = await NVImage.loadFromUrl({
      url: URL.createObjectURL(new Blob([nifti as BlobPart])),
      name,
      colormap: colorMap,
      opacity,
    });
    this.nv.addVolume(overlay);
    this.maskIndex = this.nv.volumes.length - 1;
    this.nv.updateGLVolume();
  }

  removeMaskOverlay(): void {
    if (this.maskIndex < 0) return;
    const v = this.nv.volumes[this.maskIndex];
    if (v) this.nv.removeVolume(v);
    this.maskIndex = -1;
    this.nv.updateGLVolume();
  }

  setMaskOpacity(opacity: number): void {
    if (this.maskIndex < 0) return;
    const v = this.nv.volumes[this.maskIndex];
    if (!v) return;
    v.opacity = Math.max(0, Math.min(1, opacity));
    this.nv.updateGLVolume();
  }

  setMaskColormap(colormap: OverlayColorMap): void {
    if (this.maskIndex < 0) return;
    const v = this.nv.volumes[this.maskIndex];
    if (!v) return;
    v.colormap = colormap;
    this.nv.updateGLVolume();
  }

  /**
   * Set window centre/width on the primary volume. Pass -1 for either to
   * leave it untouched (NiiVue auto-windows on load).
   */
  setWindow(level: number, width: number): void {
    if (this.primaryIndex < 0) return;
    const v = this.nv.volumes[this.primaryIndex] as
      | { cal_min?: number; cal_max?: number }
      | undefined;
    if (!v) return;
    if (level >= 0 && width > 0) {
      v.cal_min = level - width / 2;
      v.cal_max = level + width / 2;
    }
    this.nv.updateGLVolume();
  }

  // ── Drawing layer ────────────────────────────────────────────────────────
  setDrawingEnabled(on: boolean): void {
    (this.nv as unknown as NVDriver).drawingEnabled = on;
  }

  /** Set the brush label index. Pass `0` for eraser. */
  setBrushLabel(label: number): void {
    (this.nv as unknown as NVDriver).setPenValue(label, true);
  }

  undoLastBrushStroke(): void {
    (this.nv as unknown as NVDriver).drawUndo();
  }

  /** Persist the draw layer onto the segmentation overlay. */
  flattenDrawingIntoMask(): void {
    // NiiVue's drawing layer auto-syncs into nv.drawBitmap; the visual already
    // reflects the strokes. This helper is a no-op today, kept so the call
    // site can be wired once we add a "save corrections" workflow.
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

function extractVolume(image: NVImage): LoadedVolume {
  const hdr = image.hdr as NVImageHeader | undefined;
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
  if (!img) throw new Error('NiiVue produced no voxel data for this volume.');
  const dtype = inferDtype(img);
  const voxels = img as
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint8Array
    | Float32Array;
  return { voxels, meta: { dims, spacing, origin, dtype } };
}

function inferDtype(arr: ArrayBufferView): VolumeMetadata['dtype'] {
  if (arr instanceof Int16Array) return 'int16';
  if (arr instanceof Uint16Array) return 'uint16';
  if (arr instanceof Int32Array) return 'int32';
  if (arr instanceof Float32Array) return 'float32';
  return 'uint8';
}
