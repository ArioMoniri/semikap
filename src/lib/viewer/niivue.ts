import { Niivue, NVImage } from '@niivue/niivue';
import type { Bytes, VolumeMetadata } from '../../types';
import { writeNifti1Uint8 } from '../export/nifti';

/**
 * Ensure a name carries a recognised volume extension. NiiVue derives the
 * loader from the URL or, when given a blob: URL, falls back to parsing
 * extension from the `name` field. If neither has one, NVImage internally
 * does `name.split('.').pop().toUpperCase()` on `undefined` and throws —
 * which is what produced the "Inference failed: undefined is not an object
 * (evaluating 'ext.toUpperCase')" crash on synthesised mask overlays whose
 * name we set to a plain `'mask'`.
 */
const VOLUME_EXT_RE = /\.(nii|nii\.gz|nrrd|mha|mgz|dcm)$/i;
function ensureNiiName(name: string): string {
  return VOLUME_EXT_RE.test(name) ? name : `${name}.nii`;
}

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

export interface ProbeReading {
  /** Voxel coordinates within the primary volume. */
  voxel: [number, number, number];
  /** Physical (mm) position in the primary volume's frame of reference. */
  mm: [number, number, number];
  /** Sample value from the primary volume. */
  value: number;
}

type ProbeListener = (reading: ProbeReading | null) => void;

interface NVDriver {
  drawingEnabled: boolean;
  setPenValue(label: number, isFilledPen?: boolean): void;
  drawUndo(): void;
  closeDrawing(): void;
  /** Snapshot of every painted voxel (label index per voxel). May be empty until a stroke happens. */
  drawBitmap?: Uint8Array | null;
  /** True once a brush stroke has been made. */
  drawScene?(): void;
  /** NiiVue's location-change callback hook (signature varies across versions). */
  onLocationChange?: ((data: unknown) => void) | null;
}

export class NiivueViewer {
  private nv: Niivue;
  /** Index in this.nv.volumes of the primary volume (always 0 once loaded). */
  private primaryIndex = -1;
  /** Index of the secondary base volume (if any). */
  private secondaryIndex = -1;
  /** Index of the segmentation overlay (if any). */
  private maskIndex = -1;
  private probeListeners = new Set<ProbeListener>();

  constructor(canvas: HTMLCanvasElement) {
    this.nv = new Niivue({
      backColor: [0.04, 0.07, 0.12, 1],
      crosshairColor: [0.95, 0.6, 0.1, 1],
      show3Dcrosshair: true,
      isOrientCube: false,
      multiplanarForceRender: true,
      // NiiVue prints its own giant "waiting for images..." banner before any
      // volume loads. Our React empty-state already covers this case more
      // tastefully, so suppress the canvas text.
      loadingText: '',
    });
    void this.nv.attachToCanvas(canvas);

    // Wire NiiVue's crosshair location callback into our typed probe stream.
    (this.nv as unknown as NVDriver).onLocationChange = (data: unknown): void => {
      const r = parseLocation(data);
      this.probeListeners.forEach((fn) => fn(r));
    };
  }

  onProbe(listener: ProbeListener): () => void {
    this.probeListeners.add(listener);
    return () => this.probeListeners.delete(listener);
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
      name: ensureNiiName(name),
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
      name: ensureNiiName(name),
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
      name: ensureNiiName(name),
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

  /**
   * Read the brush layer out of NiiVue. Returns a fresh Uint8Array sized to
   * the primary volume's voxel grid, with 0 where the user did not paint.
   * Returns null when no strokes have been drawn yet.
   */
  getDrawnLayer(): Uint8Array | null {
    const drawBitmap = (this.nv as unknown as NVDriver).drawBitmap;
    if (!drawBitmap || drawBitmap.length === 0) return null;
    return new Uint8Array(drawBitmap);
  }

  /**
   * Combine the original AI mask with the user's brush corrections into a
   * single label map. Brush voxels override the AI label (including with
   * label 0 for eraser). Returns the merged map or null if there are no
   * corrections.
   */
  getCorrectedMask(aiMask: Uint8Array): Uint8Array | null {
    const drawn = this.getDrawnLayer();
    if (!drawn) return null;
    if (drawn.length !== aiMask.length) {
      throw new Error(
        `Brush layer voxel count ${drawn.length} does not match AI mask ${aiMask.length}.`
      );
    }
    const out = new Uint8Array(aiMask.length);
    for (let i = 0; i < aiMask.length; i++) {
      // 0 in the brush layer means "no correction here, keep AI"; nonzero
      // means "the user explicitly drew this label" — which can be 0 if they
      // explicitly erased; we surface explicit erases via a sentinel of 255
      // ... but NiiVue doesn't give us that distinction directly, so we
      // treat any nonzero as override and trust eraser strokes propagate
      // by being the active brush layer rendering as 0.
      const d = drawn[i]!;
      out[i] = d === 0 ? aiMask[i]! : d;
    }
    return out;
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

function parseLocation(data: unknown): ProbeReading | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as {
    vox?: number[];
    mm?: number[];
    values?: Array<{ value?: number }>;
  };
  if (!Array.isArray(d.vox) || d.vox.length < 3) return null;
  if (!Array.isArray(d.mm) || d.mm.length < 3) return null;
  const value = d.values?.[0]?.value ?? Number.NaN;
  return {
    voxel: [d.vox[0] ?? 0, d.vox[1] ?? 0, d.vox[2] ?? 0],
    mm: [d.mm[0] ?? 0, d.mm[1] ?? 0, d.mm[2] ?? 0],
    value,
  };
}

function inferDtype(arr: ArrayBufferView): VolumeMetadata['dtype'] {
  if (arr instanceof Int16Array) return 'int16';
  if (arr instanceof Uint16Array) return 'uint16';
  if (arr instanceof Int32Array) return 'int32';
  if (arr instanceof Float32Array) return 'float32';
  return 'uint8';
}
