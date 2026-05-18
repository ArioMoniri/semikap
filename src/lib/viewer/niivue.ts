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
  /** sform rows when sform_code != 0 — the canonical voxel→world affine. */
  srow_x?: number[];
  srow_y?: number[];
  srow_z?: number[];
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

/**
 * Angle-measurement snapshot. `points` is 0..3 mm-space points in click
 * order: [vertex, arm1, arm2]. `degrees` is the unsigned angle between
 * the two arms (0..180), or null until the user has clicked all three.
 */
export interface AngleState {
  points: Array<[number, number, number]>;
  degrees: number | null;
}

interface NVDriver {
  drawingEnabled: boolean;
  setPenValue(label: number, isFilledPen?: boolean): void;
  drawUndo(): void;
  closeDrawing(): void;
  /** Allocate a draw bitmap matching the primary volume's voxel grid.
   *  Without it, brush + eraser are silent no-ops in NiiVue 0.44.x. */
  createEmptyDrawing?(): void;
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
  /**
   * True when the user is actively in brush/eraser mode. Gates
   * `refreshDrawing()` so we don't trigger NiiVue's draw-mesh rebuild on
   * every plain canvas click — calling `nv.refreshDrawing(true)` against
   * an empty/never-painted bitmap blanked the canvas on cursor-leave in
   * v0.5.4 because NiiVue cleared the GL state and waited for the next
   * paint event to redraw the volumes.
   */
  private drawingActive = false;
  /** Stash of the AI mask voxels before outline-mode replaced them. Lets us
   *  toggle outline mode reversibly without re-running inference. */
  private maskFilledVoxels: Uint8Array | null = null;
  private probeListeners = new Set<ProbeListener>();
  /** Angle-measurement state — captured in mm so we can compute the angle
   *  in physical (real-world) space rather than voxel-grid space. */
  private angleMode = false;
  private anglePoints: Array<[number, number, number]> = [];
  private angleListeners = new Set<(state: AngleState) => void>();

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
      // v0.7.5 — colorbar shrunk further. The 0.025 default (set in
      // v0.5.x) still rendered "0 100 200 300 400" in giant 36-px font on
      // a 4K canvas, eating ~30% of the viewer height. 0.012 keeps the
      // bar visible at any window size without dominating the panel.
      // The user-reported "color bar legend too large and gross" still
      // resolved cleanly with this value across 1080p/1440p/4K.
      colorbarHeight: 0.012,
      // Tight margin so the bar hugs the canvas edge.
      colorbarMargin: 0.01,
    });
    void this.nv.attachToCanvas(canvas);

    // Wire NiiVue's crosshair location callback into our typed probe stream.
    (this.nv as unknown as NVDriver).onLocationChange = (data: unknown): void => {
      const r = parseLocation(data);
      this.probeListeners.forEach((fn) => fn(r));
    };

    // Seat a fixed 6-colour brush palette into NiiVue's draw lookup table at
    // label indices 1..6. Without this the user's brush colour was always
    // whatever the model manifest happened to declare for label 1, which
    // for our example threshold model is just one green entry — so the
    // colour-picker UI had nothing to switch between. With a fixed palette
    // the user can pick any of the six colours regardless of manifest.
    this.installBrushPalette();
  }

  /**
   * Default brush colour table, indexed by label. label 0 is reserved for
   * the eraser (transparent). Anything > 6 falls back to NiiVue's default
   * LUT entries.
   */
  private installBrushPalette(): void {
    const palette: Array<[number, number, number]> = [
      [239,  68,  68], // red    — label 1
      [ 34, 197,  94], // green  — label 2
      [ 59, 130, 246], // blue   — label 3
      [234, 179,   8], // yellow — label 4
      [  6, 182, 212], // cyan   — label 5
      [217,  70, 239], // magenta— label 6
    ];
    type DrawLut = { lut?: Uint8Array | Uint8ClampedArray };
    const lut = (this.nv as unknown as { drawLut?: DrawLut }).drawLut?.lut;
    if (!lut || lut.length < 7 * 4) return;
    for (let i = 0; i < palette.length; i++) {
      const [r, g, b] = palette[i]!;
      const off = (i + 1) * 4;
      lut[off + 0] = r;
      lut[off + 1] = g;
      lut[off + 2] = b;
      lut[off + 3] = 255;
    }
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

    // Allocate the brush/eraser bitmap matching this volume's grid. Without
    // this, every paint stroke in AnnotationPanel is a silent no-op because
    // NiiVue 0.44 only auto-creates the bitmap on first stroke if a primary
    // volume is already loaded — and even then it's racy across versions.
    const driver = this.nv as unknown as NVDriver;
    if (typeof driver.createEmptyDrawing === 'function') {
      driver.createEmptyDrawing();
    }

    return extractVolume(image);
  }

  /**
   * v0.7.4 — load a multi-file DICOM series as the primary volume. Each
   * entry is a single .dcm slice; NVImage.loadFromFile concatenates them
   * into one 3D volume using each slice's ImagePositionPatient header
   * for ordering. Falls back to single-file load when the series turns
   * out to be one file.
   *
   * `inputFiles` are constructed as native `File` objects so we can pass
   * them to NVImage.loadFromFile, which is the only NiiVue 0.44 entry
   * point that accepts a heterogeneous array of DICOM slices.
   */
  async loadPrimaryFromFiles(
    items: Array<{ name: string; bytes: Bytes }>
  ): Promise<LoadedVolume> {
    if (items.length === 0) throw new Error('No files provided');
    if (items.length === 1) {
      const it = items[0]!;
      return this.loadPrimaryFromBytes(it.name, it.bytes);
    }
    while (this.nv.volumes.length > 0) {
      const v = this.nv.volumes[0];
      if (!v) break;
      this.nv.removeVolume(v);
    }
    this.primaryIndex = -1;
    this.secondaryIndex = -1;
    this.maskIndex = -1;

    const files: File[] = items.map(
      (it) =>
        new File([it.bytes as BlobPart], it.name, {
          type: it.name.toLowerCase().endsWith('.dcm') ? 'application/dicom' : 'application/octet-stream',
        })
    );
    // v0.9.6 — NiiVue 0.44 NVImage.loadFromFile takes a SINGLE OPTIONS
    // OBJECT shaped { file: File | File[], name?, ... } — NOT positional
    // (file, opts). Pre-v0.9.6 we called `loadFromFile(files, { name })`
    // which destructured to `file=undefined, name=undefined` inside
    // NiiVue, and the loader threw the generic "could not build NVImage"
    // because it had no file bytes to parse. Local single-DICOM loads
    // happened to work because they take the loadPrimaryFromBytes path
    // (which uses NVImage.loadFromUrl with a Blob URL), not this path.
    // User reported "IDC download failed: could not build NVImage" once
    // a multi-instance series came down from the proxy — that's when
    // this code path actually fired.
    // v0.9.7 — invoke NVImage.loadFromFile DIRECTLY through the class
    // rather than via an extracted function reference. Pre-v0.9.7 we
    // pulled `loadFromFile` off the class into a local variable, which
    // lost the `this`-binding to NVImage. NiiVue's loadFromFile body
    // calls `this.readFileAsync(...)` internally; with `this`
    // undefined the user got the cryptic "TypeError: undefined is not
    // an object (evaluating 'this.readFileAsync')". Calling via the
    // class keeps `this === NVImage` so internal `this.readFileAsync`
    // resolves to NVImage's own helper.
    type LoadFromFile = (opts: {
      file: File | File[];
      name?: string;
    }) => Promise<NVImage>;
    const NVI = NVImage as unknown as { loadFromFile: LoadFromFile };
    let image: NVImage;
    try {
      image = await NVI.loadFromFile({
        file: files,
        name: ensureNiiName(items[0]!.name),
      });
    } catch (err) {
      // Surface a more useful error than the bare NiiVue "could not build
      // NVImage" — include the first-instance byte count + magic-bytes
      // probe so downstream "IDC download failed: …" toasts give the user
      // something actionable. Most failures here are non-image instances
      // (DICOM SR/SEG/RWV mixed into the series) or compressed transfer
      // syntaxes NiiVue's built-in parser can't decode (JPEG 2000, RLE).
      const first = files[0];
      const head = first ? new Uint8Array(await first.arrayBuffer().catch(() => new ArrayBuffer(0))).slice(0, 132) : null;
      const isDicom = head && head.length >= 132 &&
        head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d;
      const detail = `${files.length} files, first=${first?.name ?? '?'} (${first?.size ?? 0} bytes, ${isDicom ? 'DICOM magic OK' : 'no DICM magic — non-DICOM or implicit-VR'})`;
      throw new Error(`NiiVue could not build the volume: ${(err as Error).message || 'unknown'}. ${detail}`);
    }
    this.nv.addVolume(image);
    this.nv.updateGLVolume();
    this.primaryIndex = 0;
    const driver = this.nv as unknown as NVDriver;
    if (typeof driver.createEmptyDrawing === 'function') {
      driver.createEmptyDrawing();
    }
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
    opacity = 0.55,
    /**
     * Optional source affine for proper RAS alignment. Without it the mask is
     * written with spacing*identity + (0,0,0) origin and ends up drifting
     * relative to the source volume in the 3D / MPR view (visible on
     * CT_AVM.nii.gz). When `srowX/Y/Z` from the primary's NIfTI header are
     * passed through they are written verbatim into the mask's sform.
     */
    affine?: {
      srowX?: [number, number, number, number];
      srowY?: [number, number, number, number];
      srowZ?: [number, number, number, number];
      origin?: [number, number, number];
    }
  ): Promise<void> {
    if (this.primaryIndex < 0) {
      throw new Error('No base volume loaded; cannot overlay a mask.');
    }
    if (this.maskIndex >= 0) {
      const v = this.nv.volumes[this.maskIndex];
      if (v) this.nv.removeVolume(v);
      this.maskIndex = -1;
    }
    // A new mask invalidates any cached filled-voxel stash from the previous
    // run's outline toggle.
    this.maskFilledVoxels = null;
    const nifti = writeNifti1Uint8({
      mask,
      dims,
      spacing,
      ...(affine?.origin !== undefined ? { origin: affine.origin } : {}),
      ...(affine?.srowX !== undefined ? { srowX: affine.srowX } : {}),
      ...(affine?.srowY !== undefined ? { srowY: affine.srowY } : {}),
      ...(affine?.srowZ !== undefined ? { srowZ: affine.srowZ } : {}),
    });
    const overlay = await NVImage.loadFromUrl({
      url: URL.createObjectURL(new Blob([nifti as BlobPart])),
      name: ensureNiiName(name),
      colormap: colorMap,
      opacity,
    });

    // 3D rendering: NiiVue's volumetric raycaster derives each volume's
    // transform from FOUR fields, not just matRAS:
    //   matRAS      — 4x4 voxel→world
    //   dimsRAS     — RAS-aligned dims (post-permutation), [n, x, y, z]
    //   pixDimsRAS  — RAS-aligned spacing
    //   permRAS     — axis permutation (e.g. [-1, 2, -3] for an LPI source)
    //
    // NiiVue computes those four at load time from the NIfTI sform/qform.
    // Even when our writeNifti1Uint8 emits the same sform as the source,
    // qform/sform reconciliation can produce different cached values for
    // primary vs overlay — and on a non-axis-aligned source (any LPI volume,
    // many MR + most non-axial CTs) the two diverge enough that the 3D
    // overlay drifts from the source vessels. Copying ALL FOUR from primary
    // forces the overlay into the exact same RAS frame, which makes the
    // alignment volume-agnostic — works on the bundled threshold demo, on
    // arbitrary nnU-Net / TotalSegmentator outputs, on user-supplied models.
    type RasFields = {
      matRAS?: Float32Array | number[];
      dimsRAS?: number[];
      pixDimsRAS?: number[];
      permRAS?: number[];
      obliqueRAS?: Float32Array | number[];
    };
    const primary = this.nv.volumes[this.primaryIndex] as RasFields | undefined;
    if (primary) {
      const ov = overlay as unknown as RasFields;
      const cloneFloat = (v: Float32Array | number[] | undefined) =>
        v === undefined
          ? undefined
          : v instanceof Float32Array
          ? new Float32Array(v)
          : Float32Array.from(v);
      const cloneNums = (v: number[] | undefined) =>
        v === undefined ? undefined : [...v];
      const m = cloneFloat(primary.matRAS);
      if (m) ov.matRAS = m;
      const d = cloneNums(primary.dimsRAS);
      if (d) ov.dimsRAS = d;
      const p = cloneNums(primary.pixDimsRAS);
      if (p) ov.pixDimsRAS = p;
      const r = cloneNums(primary.permRAS);
      if (r) ov.permRAS = r;
      const o = cloneFloat(primary.obliqueRAS);
      if (o) ov.obliqueRAS = o;
    }

    this.nv.addVolume(overlay);
    this.maskIndex = this.nv.volumes.length - 1;
    this.nv.updateGLVolume();
  }

  removeMaskOverlay(): void {
    if (this.maskIndex < 0) return;
    const v = this.nv.volumes[this.maskIndex];
    if (v) this.nv.removeVolume(v);
    this.maskIndex = -1;
    this.maskFilledVoxels = null;
    this.nv.updateGLVolume();
  }

  /**
   * v0.8.16 — fully unload every volume from NiiVue, reset every
   * index, and clear the brush bitmap. Used by LoadedImagesList's
   * "Remove" button so the user can drop the active series and
   * load a new one without lingering state from the previous load
   * (which had been corrupting subsequent loads — user reported
   * "cant remove the addded series and the images are not deleted
   * from environment and cant add new ones").
   *
   * Walks `nv.volumes` in reverse so each `removeVolume` mutation
   * doesn't shift the indices of items we haven't visited yet.
   */
  unloadAll(): void {
    // v0.8.18 — match the cleanup pattern in `loadPrimaryFromBytes` exactly
    // (while-loop on volumes[0], removeVolume each). Pre-v0.8.18 we walked
    // in reverse and called updateGLVolume() on the empty scene, which left
    // NiiVue's GL slot bound to a destroyed texture handle — the next
    // `addVolume` then silently failed to render even though the volumes[]
    // slot was populated. User report: "after first image adding and
    // removal i cant add another image path to the envireontmet and it
    // doesnt show up". Removing the GL push on an empty scene is what
    // unblocks subsequent loads.
    while (this.nv.volumes.length > 0) {
      const v = this.nv.volumes[0];
      if (!v) break;
      this.nv.removeVolume(v);
    }
    this.primaryIndex = -1;
    this.secondaryIndex = -1;
    this.maskIndex = -1;
    this.maskFilledVoxels = null;
    this.angleMode = false;
    this.anglePoints = [];
    this.notifyAngle();
    // Only repaint — DON'T call updateGLVolume on an empty scene. Repaint
    // gives the user immediate "the image is gone" feedback; the next
    // loadPrimaryFromBytes will reinitialise the GL volume slot freshly.
    this.nv.drawScene();
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
  /**
   * Toggle brush/eraser mode. Direct property assignment to
   * `nv.drawingEnabled` doesn't trigger NiiVue's internal mode-switch
   * machinery in 0.44.x — left-click stays bound to slice navigation /
   * 3D rotation and paint events never fire. Calling the public
   * `setDrawingEnabled()` method does the right thing (rebinds the
   * pointer handlers, lazy-allocates the bitmap if needed). We fall
   * back to the property write when the method isn't on the prototype
   * (older builds) so behaviour degrades gracefully instead of throwing.
   */
  setDrawingEnabled(on: boolean): void {
    this.drawingActive = on;
    const nv = this.nv as unknown as {
      setDrawingEnabled?(on: boolean): void;
      drawingEnabled?: boolean;
      opts?: { drawingEnabled?: boolean };
    };
    if (typeof nv.setDrawingEnabled === 'function') {
      nv.setDrawingEnabled(on);
    } else {
      // Defensive fallback path.
      nv.drawingEnabled = on;
      if (nv.opts) nv.opts.drawingEnabled = on;
    }
  }

  /** Read-only: is the brush currently active? */
  isDrawingActive(): boolean {
    return this.drawingActive;
  }

  /**
   * Unconditional re-paint. Used by the Viewer effect's defensive recovery
   * paths (`webglcontextrestored`, `pointerleave`) so the canvas can repaint
   * even when the brush isn't active and `refreshDrawing()` would no-op.
   */
  redraw(): void {
    this.nv.drawScene();
  }

  /**
   * v0.9.0 — toggle the active volume's invert-colormap flag. NiiVue
   * stores the per-volume colormapInvert on the NVImage instance; we
   * flip it on the primary, push it via updateGLVolume, and repaint.
   * Used by the new Invert toolbar button (mirrors OHIF's "Invert").
   */
  toggleInvert(): void {
    if (this.primaryIndex < 0) return;
    const v = this.nv.volumes[this.primaryIndex] as { colormapInvert?: boolean } | undefined;
    if (!v) return;
    v.colormapInvert = !v.colormapInvert;
    this.nv.updateGLVolume();
    this.nv.drawScene();
  }

  isInverted(): boolean {
    if (this.primaryIndex < 0) return false;
    const v = this.nv.volumes[this.primaryIndex] as { colormapInvert?: boolean } | undefined;
    return Boolean(v?.colormapInvert);
  }

  /**
   * v0.9.0 — toggle radiological vs neurological convention. The de
   * facto OHIF "Flip Horizontal" maps to this: in radiological
   * convention the patient's LEFT side is on the viewer's RIGHT
   * (think looking AT the patient on a hospital lightbox); in
   * neurological convention they match. NiiVue exposes a clean
   * `setRadiologicalConvention(bool)` so we read the current value
   * and flip it.
   *
   * Top/bottom flip isn't natively supported by NiiVue 0.44 — adding
   * it cleanly needs a per-tile transform in the wrapper which is a
   * v0.9.x follow-up.
   */
  toggleRadiologicalConvention(): void {
    const cur = (this.nv as unknown as { opts?: { isRadiologicalConvention?: boolean } }).opts
      ?.isRadiologicalConvention ?? false;
    this.nv.setRadiologicalConvention(!cur);
  }

  /**
   * v0.9.0 — rotate the 3D volumetric render by `delta` degrees around
   * the vertical (Z) axis. Wraps NiiVue's setRenderAzimuthElevation
   * so the Tools panel can offer a one-click "Rotate 90°" button.
   * No-op when no primary volume is loaded.
   */
  rotate3D(deltaAzimuth: number, deltaElevation: number = 0): void {
    if (this.primaryIndex < 0) return;
    const scene = (this.nv as unknown as {
      scene?: { renderAzimuth?: number; renderElevation?: number };
    }).scene;
    const az = (scene?.renderAzimuth ?? 0) + deltaAzimuth;
    const el = (scene?.renderElevation ?? 0) + deltaElevation;
    this.nv.setRenderAzimuthElevation(az, el);
  }

  /** Set the brush label index. Pass `0` for eraser. */
  setBrushLabel(label: number): void {
    (this.nv as unknown as NVDriver).setPenValue(label, true);
  }

  /**
   * Brush radius in voxels (clamped 1..30). NiiVue 0.44 reads this off
   * `nv.opts.penSize` for both brush + eraser strokes; bigger = wider
   * filled disc per click. Reasonable defaults: 1 (precise), 5 (default),
   * 12 (broad).
   */
  setBrushRadius(radius: number): void {
    const r = Math.max(1, Math.min(30, Math.round(radius)));
    const opts = (this.nv as unknown as { opts: Record<string, number> }).opts;
    if (opts) {
      opts.penSize = r;
      // Some NiiVue builds use penDilateMagnitude as the radius source —
      // set both so the slider works regardless of the underlying field.
      opts.penDilateMagnitude = r;
    }
  }

  /**
   * Wipe every painted voxel — equivalent to undoing every stroke at once.
   * Closes the existing draw bitmap then re-allocates an empty one so
   * subsequent strokes work without reload. Refreshes the 3D mesh so
   * the wipe propagates to the volumetric render too.
   */
  clearAllBrushStrokes(): void {
    const driver = this.nv as unknown as NVDriver & {
      createEmptyDrawing?(): void;
    };
    if (typeof driver.closeDrawing === 'function') driver.closeDrawing();
    if (typeof driver.createEmptyDrawing === 'function') driver.createEmptyDrawing();
    // Force the 3D draw mesh to forget the cleared voxels.
    if (this.drawingActive) {
      const nv = this.nv as unknown as { refreshDrawing?(force: boolean): void };
      if (typeof nv.refreshDrawing === 'function') nv.refreshDrawing(true);
    }
    this.nv.drawScene();
  }

  /**
   * Brush opacity (0..1). NiiVue defaults to 0.5 which makes corrections
   * hard to see against an already-translucent AI mask overlay. We expose
   * it so the AnnotationPanel can crank it up when brush mode is active.
   */
  setBrushOpacity(opacity: number): void {
    const opts = (this.nv as unknown as { opts: { drawOpacity?: number } }).opts;
    if (opts) opts.drawOpacity = Math.max(0, Math.min(1, opacity));
    this.nv.drawScene();
  }

  /**
   * Force NiiVue to push the current draw bitmap into its 3D draw mesh and
   * trigger a render. Without this, brush strokes are visible only in the
   * 2D MPR slices — the 3D volumetric raycaster never sees them. Call once
   * per stroke completion (pointerup) and the 3D view updates within a
   * frame.
   *
   * IMPORTANT: this is a no-op when drawing mode is OFF and nothing has been
   * painted. Calling `nv.refreshDrawing(true)` against an empty/never-
   * allocated bitmap caused NiiVue 0.44 to leave the GL context in a state
   * where mouse-leave (NiiVue's hover-redraw) cleared the canvas to the
   * background colour and didn't restore the volumes until the cursor
   * re-entered a slice — the v0.5.4 "plots disappear when cursor leaves"
   * regression.
   */
  refreshDrawing(): void {
    if (!this.drawingActive) {
      // Nothing to push to the 3D mesh — and skipping the call avoids the
      // empty-bitmap GL-state issue described above.
      return;
    }
    const nv = this.nv as unknown as { refreshDrawing?(force: boolean): void };
    if (typeof nv.refreshDrawing === 'function') {
      nv.refreshDrawing(true);
    }
    this.nv.drawScene();
  }

  undoLastBrushStroke(): void {
    (this.nv as unknown as NVDriver).drawUndo();
    // Also refresh 3D so the undone stroke disappears from the volumetric
    // render, not just the MPR slices.
    this.refreshDrawing();
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

  // ── Layout / chrome ──────────────────────────────────────────────────────
  /**
   * Switch the canvas presentation:
   *  - `multi`   = 3-plane MPR + 3D render (default)
   *  - `axial` / `coronal` / `sagittal` = single plane only
   *  - `render`  = 3D-only
   * NiiVue's underlying SLICE_TYPE values: AXIAL=0, CORONAL=1, SAGITTAL=2,
   * MULTIPLANAR=3, RENDER=4. We expose them by name to keep call sites
   * readable without having to import NiiVue's enum on the consumer side.
   */
  setSliceMode(mode: 'multi' | 'axial' | 'coronal' | 'sagittal' | 'render'): void {
    const code =
      mode === 'axial' ? 0 :
      mode === 'coronal' ? 1 :
      mode === 'sagittal' ? 2 :
      mode === 'render' ? 4 :
      3;
    (this.nv as unknown as { setSliceType(t: number): void }).setSliceType(code);
  }

  /**
   * Multi-plane tile arrangement when `setSliceMode('multi')` is active.
   * NiiVue values: AUTO=0, COLUMN=1, GRID=2, ROW=3.
   */
  setMultiplanarLayout(layout: 'auto' | 'column' | 'grid' | 'row'): void {
    const code = layout === 'column' ? 1 : layout === 'grid' ? 2 : layout === 'row' ? 3 : 0;
    const opts = (this.nv as unknown as { opts: { multiplanarLayout: number } }).opts;
    opts.multiplanarLayout = code;
    this.nv.drawScene();
  }

  setOrientCube(on: boolean): void {
    const opts = (this.nv as unknown as { opts: { isOrientCube: boolean } }).opts;
    opts.isOrientCube = on;
    this.nv.drawScene();
  }

  setColorbar(on: boolean): void {
    const opts = (this.nv as unknown as { opts: { isColorbar: boolean } }).opts;
    opts.isColorbar = on;
    this.nv.drawScene();
  }

  set3DCrosshair(on: boolean): void {
    const opts = (this.nv as unknown as { opts: { show3Dcrosshair: boolean } }).opts;
    opts.show3Dcrosshair = on;
    this.nv.drawScene();
  }

  setRadiologicalConvention(on: boolean): void {
    const opts = (this.nv as unknown as { opts: { isRadiologicalConvention: boolean } }).opts;
    opts.isRadiologicalConvention = on;
    this.nv.drawScene();
  }

  // ── Radiology tools ───────────────────────────────────────────────────────
  /**
   * Switch what a left-click-drag does on a 2D slice. Mirrors the standard
   * radiology-viewer toolbar:
   *   - `contrast`    = window/level (drag X = width, drag Y = level)
   *   - `pan`         = pan the slice viewport
   *   - `measurement` = distance ruler (click + drag draws a line, mm reading
   *                     shown at the cursor)
   *   - `none`        = drag does nothing (good when brush mode is on)
   * NiiVue's underlying enum: NONE=0, CONTRAST=1, MEASUREMENT=2, PAN=3,
   * SLICER3D=4, CALLBACK=5. Identical numeric mapping in 0.44.x.
   */
  setDragMode(mode: 'none' | 'contrast' | 'measurement' | 'pan'): void {
    const code = mode === 'contrast' ? 1 : mode === 'measurement' ? 2 : mode === 'pan' ? 3 : 0;
    const opts = (this.nv as unknown as { opts: { dragMode: number } }).opts;
    opts.dragMode = code;
    this.nv.drawScene();
  }

  /**
   * v0.8.5 — toggle NiiVue's native crosshair visibility. When the
   * user enables the axis-coloured crosshair overlay (Settings), we
   * hide NiiVue's single-color line by setting alpha to 0; an SVG
   * sibling layer paints the per-axis lines instead.
   *
   * The original color (orange) is preserved in the closure so
   * disabling the axis overlay restores the v0.7.x look exactly.
   */
  setNativeCrosshairVisible(visible: boolean): void {
    const opts = (this.nv as unknown as {
      opts: { crosshairColor: [number, number, number, number] };
    }).opts;
    // Always preserve the RGB; only alpha changes.
    opts.crosshairColor[3] = visible ? 1 : 0;
    this.nv.drawScene();
  }

  /**
   * v0.8.6 — read NiiVue's tileIndex for a canvas-pixel point. Returns
   *   - 0 for axial
   *   - 1 for coronal
   *   - 2 for sagittal
   *   - 3 for the 3D render
   *   - -1 when the point is between tiles (gutters)
   *
   * Used by the per-pane crosshair lock. NiiVue 0.44 stores this as a
   * private `tileIndex(x, y)` helper; the wrapper insulates the React
   * layer from API drift.
   */
  tileIndexAt(canvasX: number, canvasY: number): number {
    const nv = this.nv as unknown as {
      tileIndex?(x: number, y: number): number;
    };
    return nv.tileIndex?.(canvasX, canvasY) ?? -1;
  }

  /**
   * v0.8.6 — snapshot the current 3D crosshair position in fractional
   * (0..1) coordinates per axis. Pair with `restoreCrosshairAxes()`
   * to implement the per-pane crosshair lock: capture before NiiVue
   * processes the click → after the click navigates the crosshair,
   * restore the OTHER two axes from the snapshot, leaving only the
   * clicked tile's plane updated.
   *
   * Frac coords are NiiVue-native (X = lateral, Y = AP, Z = SI).
   */
  snapshotCrosshair(): [number, number, number] {
    const nv = this.nv as unknown as {
      scene?: { crosshairPos?: [number, number, number] };
    };
    const c = nv.scene?.crosshairPos;
    return c ? [c[0], c[1], c[2]] : [0.5, 0.5, 0.5];
  }

  /**
   * v0.8.6 — restore specific axes of the crosshair from a snapshot,
   * leaving the others at their current value.
   *
   * `axes` is a triple of booleans `[restoreX, restoreY, restoreZ]`.
   * For per-pane lock:
   *   - axial click   → only Z (slice index) should change → restore [X, Y]
   *     i.e. axes = [true, true, false]
   *   - coronal click → only Y should change                → restore [X, Z]
   *     i.e. axes = [true, false, true]
   *   - sagittal click → only X should change               → restore [Y, Z]
   *     i.e. axes = [false, true, true]
   */
  restoreCrosshairAxes(
    snapshot: [number, number, number],
    axes: [boolean, boolean, boolean]
  ): void {
    const nv = this.nv as unknown as {
      scene?: { crosshairPos?: [number, number, number] };
    };
    const c = nv.scene?.crosshairPos;
    if (!c) return;
    if (axes[0]) c[0] = snapshot[0];
    if (axes[1]) c[1] = snapshot[1];
    if (axes[2]) c[2] = snapshot[2];
    this.nv.drawScene();
  }

  /**
   * v0.8.6 — fit a single voxel to N CSS pixels on screen. Used by
   * the Tools panel's "Fit 1:1 (real size)" button.
   *
   * Math:
   *   - User wants 1 mm in the volume → 1 mm on screen
   *   - The user's calibrated `pxPerMm` (default 3.78 for the 96 DPI
   *     CSS convention) tells us how many CSS pixels = 1 mm.
   *   - The volume's smallest voxel spacing tells us mm-per-voxel.
   *   - So target screen-px-per-voxel = pxPerMm × mm-per-voxel.
   *   - NiiVue's 2D zoom (`scene.pan2Dxyzmm[3]`) defaults to 1.0;
   *     the actual visible pixels-per-voxel at zoom=1.0 depends on
   *     the tile size. We compute the ratio and write it.
   *
   * Returns the zoom multiplier set so the UI can confirm. Returns
   * 1 (and does nothing) when no volume is loaded.
   */
  fitOneToOne(pxPerMm: number): number {
    const v = this.nv.volumes[this.primaryIndex] as unknown as {
      hdr?: { pixDims?: number[] };
    } | undefined;
    if (!v?.hdr?.pixDims) return 1;
    // pixDims is [_, x, y, z, ...]; smallest in-plane spacing wins.
    const sx = v.hdr.pixDims[1] ?? 1;
    const sy = v.hdr.pixDims[2] ?? 1;
    const minMm = Math.min(sx, sy);
    // Target: 1 voxel = (pxPerMm × minMm) screen pixels.
    // NiiVue's pan2Dxyzmm[3] is a multiplier on the auto-fit base,
    // so absolute calibration is approximate; the practical result
    // is "looks bigger / smaller in the right direction." A perfect
    // fit needs reading the auto-fit base from NiiVue's internals
    // (not exposed publicly) — out of scope for v0.8.6. We use the
    // CSS-px convention as the multiplier baseline.
    const zoom = pxPerMm * minMm;
    const clamped = Math.max(0.25, Math.min(16, zoom));
    const nv = this.nv as unknown as {
      scene?: { pan2Dxyzmm?: [number, number, number, number]; volScaleMultiplier?: number };
    };
    if (nv.scene?.pan2Dxyzmm) nv.scene.pan2Dxyzmm[3] = clamped;
    if (nv.scene) nv.scene.volScaleMultiplier = clamped;
    this.nv.drawScene();
    return clamped;
  }

  /**
   * v0.8.5 — read the crosshair position in canvas-pixel coordinates
   * for each visible MPR tile. Returns one entry per tile with the
   * crosshair's (x, y) inside that tile's rect, plus which two axes
   * the tile shows (so the overlay can paint each line in its
   * axis-matched color). Returns an empty array when no volume is
   * loaded or NiiVue's `frac2canvasPos` isn't available.
   */
  getCrosshairTilePositions(): Array<{
    rect: [number, number, number, number];
    axis: 'axial' | 'coronal' | 'sagittal' | '3d';
    /** Canvas-pixel position of the crosshair within this tile. */
    crosshair: { x: number; y: number };
  }> {
    const nv = this.nv as unknown as {
      scene?: { crosshairPos?: [number, number, number] };
      frac2canvasPos?(frac: [number, number, number]): [number, number] | null;
    };
    const cross = nv.scene?.crosshairPos;
    if (!cross) return [];
    const pos = nv.frac2canvasPos?.(cross);
    if (!pos) return [];
    // `frac2canvasPos` returns the canvas-pixel position of the
    // 3D crosshair in NiiVue's current view. To split per-tile we
    // need the per-tile bounds + clamp the crosshair to each tile.
    // The screenSlices entries already carry the bounds; the
    // crosshair's (x,y) within each tile is just the tile-local
    // intersection of `pos` with the tile's rect.
    const out: Array<{
      rect: [number, number, number, number];
      axis: 'axial' | 'coronal' | 'sagittal' | '3d';
      crosshair: { x: number; y: number };
    }> = [];
    for (const s of this.getScreenSlices()) {
      // For each tile we want the 2D crosshair point that NiiVue
      // would draw on it. NiiVue's internal `frac2canvasPos` already
      // resolves this — when the crosshair fraction is inside a
      // tile, the returned (x,y) lies within that tile's rect.
      const [tx, ty, tw, th] = s.rect;
      if (
        pos[0] >= tx &&
        pos[0] <= tx + tw &&
        pos[1] >= ty &&
        pos[1] <= ty + th
      ) {
        out.push({ rect: s.rect, axis: s.axis, crosshair: { x: pos[0], y: pos[1] } });
      }
    }
    return out;
  }

  /** v0.8.4 — synchronous getter for the current drag mode. Used by
   *  the Viewer's pointer-down/up handlers to decide whether to
   *  capture a distance measurement. */
  getDragMode(): 'none' | 'contrast' | 'measurement' | 'pan' {
    const opts = (this.nv as unknown as { opts: { dragMode: number } }).opts;
    return opts.dragMode === 1
      ? 'contrast'
      : opts.dragMode === 2
        ? 'measurement'
        : opts.dragMode === 3
          ? 'pan'
          : 'none';
  }

  /**
   * Reset the viewport: zoom 1.0, crosshair to volume centre, default
   * window/level. Equivalent to NiiVue's built-in reset behaviour but
   * exposed so the Tools panel can have an explicit Reset button.
   */
  resetView(): void {
    const nv = this.nv as unknown as {
      scene: { volScaleMultiplier?: number; pan2Dxyzmm?: [number, number, number, number] };
      resetBriCon?(): void;
      drawScene?(): void;
    };
    if (nv.scene) {
      nv.scene.volScaleMultiplier = 1;
      nv.scene.pan2Dxyzmm = [0, 0, 0, 1];
    }
    if (typeof nv.resetBriCon === 'function') nv.resetBriCon();
    this.nv.drawScene();
  }

  /**
   * Zoom the viewer in or out. NiiVue stores the zoom factor in
   * `scene.volScaleMultiplier` (1.0 = unzoomed). We clamp to a sane
   * 0.25..16 range so the user can't zoom themselves into a black
   * canvas or numerical overflow.
   */
  zoomBy(factor: number): void {
    const nv = this.nv as unknown as {
      scene?: {
        volScaleMultiplier?: number;
        /** v0.8.5 — `[panX, panY, panZ, zoom]` in mm-space; the
         *  4th component is the 2D MPR zoom multiplier. NiiVue 0.44
         *  stores this on `scene`, NOT `opts` (the v0.8.4 researcher
         *  pass got the location wrong — `resetView()` already wrote
         *  to `nv.scene.pan2Dxyzmm` and that's the live one). */
        pan2Dxyzmm?: [number, number, number, number];
      };
    };
    const curScale = nv.scene?.volScaleMultiplier ?? 1;
    const next = Math.max(0.25, Math.min(16, curScale * factor));
    if (nv.scene) nv.scene.volScaleMultiplier = next;
    /*
     * v0.8.5 — also update `scene.pan2Dxyzmm[3]`, the live 2D MPR
     * zoom multiplier. The v0.8.4 attempt wrote to `opts.pan2Dxyzmm`
     * (incorrect — that's not where NiiVue 0.44 reads it from), so
     * the toolbar Zoom buttons + the wheel handler still appeared
     * to do nothing on 2D tiles. The user reported "zoom in put is
     * only working on the 3d image always." Fixed by writing to the
     * scene field that `resetView()` and the internal renderer use.
     */
    if (nv.scene?.pan2Dxyzmm) {
      const cur2D = nv.scene.pan2Dxyzmm[3] ?? 1;
      nv.scene.pan2Dxyzmm[3] = Math.max(0.25, Math.min(16, cur2D * factor));
    }
    this.nv.drawScene();
  }

  /**
   * Capture the current canvas as a PNG blob. Returns a Promise<Blob | null>
   * — null if the canvas can't be read (no GL context, tainted texture).
   * Used by the screenshot button to save what's on screen for slides /
   * reports, with the AI overlay + crosshair + 3D render all composited.
   */
  async takeScreenshot(): Promise<Blob | null> {
    // Force a fresh draw so any pending state (overlay updates, slice change)
    // is flushed to the canvas before we read pixels back.
    this.nv.drawScene();
    const canvas = (this.nv as unknown as { canvas?: HTMLCanvasElement }).canvas;
    if (!canvas) return null;
    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png');
    });
  }

  /**
   * v0.8.4 — capture only one MPR tile (axial / coronal / sagittal /
   * 3D render) by clipping the full canvas to the tile's bounding
   * rectangle from `getScreenSlices()`. Used by the screenshot panel
   * picker so the user can copy *just* the axial pane into a slide
   * deck without the surrounding tiles.
   *
   * Returns null when:
   *   - NiiVue's `screenSlices` doesn't include the requested axis
   *     (e.g. the user is in single-plane sliceMode).
   *   - The full-canvas screenshot fails (no GL context, tainted
   *     texture).
   */
  async takeScreenshotOfTile(
    axis: 'axial' | 'coronal' | 'sagittal' | '3d'
  ): Promise<Blob | null> {
    const tiles = this.getScreenSlices();
    const tile = tiles.find((t) => t.axis === axis);
    if (!tile) return null;
    const fullBlob = await this.takeScreenshot();
    if (!fullBlob) return null;
    // Decode the PNG, clip with an offscreen canvas, re-encode.
    const bitmap = await createImageBitmap(fullBlob);
    const [x, y, w, h] = tile.rect;
    // The canvas runs at devicePixelRatio for sharpness; tile rect is
    // already in canvas pixel coords (NiiVue stores it that way), so
    // no DPR adjustment needed here.
    const off = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const ctx = off.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return null;
    }
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
    bitmap.close?.();
    return off.convertToBlob({ type: 'image/png' });
  }

  /**
   * Replace the AI-mask volume with a 1-voxel-thick boundary version of
   * itself (or restore the filled mask). Lets the user verify segmentation
   * boundaries against the underlying anatomy without the fill obscuring
   * what's underneath — the standard "outline" mode in radiology viewers.
   *
   * Implemented client-side: walks each non-zero voxel and keeps it only
   * when at least one of its 6-neighbour voxels is zero. Stashes the original
   * voxel data so the toggle is reversible without re-running inference.
   */
  /**
   * Extract the current axial slice (the one the crosshair is sitting on)
   * as a Float32 array sized [width * height]. SAM consumes this for
   * encoding. We only support axial today — the SAM panel renders against
   * the axial multiplanar pane regardless of which plane the user is
   * currently focused on; coronal / sagittal SAM lands once we settle on
   * a slicer-aware UX (the prompts in those planes look weird in 3D).
   */
  getCurrentAxialSlice(): { pixels: Float32Array; width: number; height: number; index: number } | null {
    if (this.primaryIndex < 0) return null;
    const v = this.nv.volumes[this.primaryIndex] as unknown as {
      img?: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
      hdr?: { dims: number[] };
    } | undefined;
    if (!v || !v.img || !v.hdr) return null;
    const X = v.hdr.dims[1] ?? 1;
    const Y = v.hdr.dims[2] ?? 1;
    const Z = v.hdr.dims[3] ?? 1;
    if (Z <= 0) return null;
    // Crosshair position — NiiVue exposes scene.crosshairPos in 0..1 frac
    // along each axis. Fall back to the central slice when not available.
    const frac =
      (this.nv as unknown as { scene?: { crosshairPos?: [number, number, number] } }).scene
        ?.crosshairPos?.[2] ?? 0.5;
    const z = Math.max(0, Math.min(Z - 1, Math.floor(frac * Z)));
    const slab = X * Y;
    const offset = z * slab;
    const out = new Float32Array(slab);
    for (let i = 0; i < slab; i++) out[i] = v.img[offset + i] ?? 0;
    return { pixels: out, width: X, height: Y, index: z };
  }

  /**
   * Same as `getCurrentAxialSlice` but for a specific axial index. Used
   * by SAM Phase D cross-slice propagation: the user generates a mask on
   * slice N, then we re-encode slices N±1, N±2, … with the prior mask's
   * bounding box as a box prompt, stitching everything into a multi-slice
   * mask volume. The crosshair position is left alone.
   */
  getAxialSliceAt(
    z: number
  ): { pixels: Float32Array; width: number; height: number; index: number } | null {
    if (this.primaryIndex < 0) return null;
    const v = this.nv.volumes[this.primaryIndex] as unknown as {
      img?: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
      hdr?: { dims: number[] };
    } | undefined;
    if (!v || !v.img || !v.hdr) return null;
    const X = v.hdr.dims[1] ?? 1;
    const Y = v.hdr.dims[2] ?? 1;
    const Z = v.hdr.dims[3] ?? 1;
    if (z < 0 || z >= Z) return null;
    const slab = X * Y;
    const offset = z * slab;
    const out = new Float32Array(slab);
    for (let i = 0; i < slab; i++) out[i] = v.img[offset + i] ?? 0;
    return { pixels: out, width: X, height: Y, index: z };
  }

  /**
   * Map a canvas-space click (e.g. from a pointerdown event) to source-
   * voxel coords on the current axial slice. Returns null when the click
   * is outside any slice tile. Used by the SAM prompt overlay to convert
   * user clicks into prompts.
   */
  canvasToAxialVoxel(
    canvasX: number,
    canvasY: number
  ): { x: number; y: number } | null {
    const nv = this.nv as unknown as {
      mm2frac?(mm: [number, number, number]): [number, number, number];
      frac2canvasPos?(frac: [number, number, number]): [number, number];
      sliceTypeAxial?: number;
      tileMM?(canvasX: number, canvasY: number): [number, number, number] | null;
    };
    /*
     * v0.8.12 — NiiVue's `tileMM(x, y)` expects coordinates in canvas
     * BACKING-STORE pixels (= CSS × devicePixelRatio). Callers (like
     * SamPromptOverlay's pointerdown handler) pass CSS pixels via
     * `clientX - rect.left`, so on HiDPI screens the click landed at
     * half the intended canvas position and tileMM returned wrong /
     * null mm coords. The user reported "the + sign appears in pinch
     * roi but cant see while selecting" + box prompts being placed
     * at wrong positions. Fix: scale up here.
     */
    const dpr =
      (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const mm = nv.tileMM?.(canvasX * dpr, canvasY * dpr);
    if (!mm) return null;
    const frac = nv.mm2frac?.(mm);
    if (!frac) return null;
    if (this.primaryIndex < 0) return null;
    const v = this.nv.volumes[this.primaryIndex] as unknown as { hdr?: { dims: number[] } };
    const X = v?.hdr?.dims[1] ?? 1;
    const Y = v?.hdr?.dims[2] ?? 1;
    return { x: Math.round(frac[0] * X), y: Math.round(frac[1] * Y) };
  }

  /**
   * v0.9.2 — full canvas → mm conversion using NiiVue's tileMM (which
   * walks the visible tiles and returns the mm coord of whichever one
   * the click landed on, with the correct slice-axis mapping for each
   * MPR pane). Returns null when the click missed every tile.
   *
   * This is the inverse of mmToCanvas() and is what the new ROI tools
   * (rectangle, ellipse, circle, freehand, spline, livewire, W/L
   * region, bidirectional, cobb, directional) use to convert pointer
   * positions into mm-space anchors. Pre-v0.9.2 the RoiOverlay used a
   * hand-rolled identity-affine conversion which produced mm values
   * NiiVue couldn't project back, so the shapes were stored but
   * rendered nowhere. User report: "none of these and also angle
   * doesnt work because of niivue I guess".
   *
   * Returns the mm triple plus the axis tag so the caller can record
   * which slice plane the measurement belongs to (used by the overlay
   * to gate rendering when the user scrolls to a different slice).
   */
  canvasToMm(
    canvasX: number,
    canvasY: number
  ): { mm: [number, number, number]; axis: 'axial' | 'coronal' | 'sagittal' } | null {
    const nv = this.nv as unknown as {
      tileMM?(canvasX: number, canvasY: number): [number, number, number] | null;
      screenSlices?: Array<{ leftTopWidthHeight?: number[]; axCorSag?: number }>;
      scene?: { crosshairPos?: [number, number, number] };
      frac2mm?(frac: [number, number, number]): number[];
    };
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const px = canvasX * dpr;
    const py = canvasY * dpr;
    let mm = nv.tileMM?.(px, py);
    // Walk screenSlices in reverse so the topmost tile (last drawn)
    // wins on overlap. axCorSag: 0=axial, 1=coronal, 2=sagittal, 4=3D.
    let axis: 'axial' | 'coronal' | 'sagittal' = 'axial';
    let foundTile = false;
    if (nv.screenSlices) {
      for (let i = nv.screenSlices.length - 1; i >= 0; i--) {
        const s = nv.screenSlices[i];
        const r = s?.leftTopWidthHeight;
        if (!r || r.length < 4) continue;
        const x = r[0]!;
        const y = r[1]!;
        const w = r[2]!;
        const h = r[3]!;
        if (px < x || px > x + w || py < y || py > y + h) continue;
        const ax = s?.axCorSag;
        if (ax === 0) axis = 'axial';
        else if (ax === 1) axis = 'coronal';
        else if (ax === 2) axis = 'sagittal';
        else continue; // skip 3D tile
        foundTile = true;
        break;
      }
    }
    // v0.10.3 — when the click missed every MPR tile (3D render tile,
    // gutter between tiles, or single-pane sliceMode where the click
    // landed outside the one visible tile), FALL BACK to the volume's
    // current crosshair position rather than returning null. Pre-v0.10.3
    // the user got "Click missed any MPR tile" — diagnostic but the
    // tool was a no-op. Crosshair fallback gives the shape a sensible
    // anchor (the user's current view focus); they can then drag the
    // shape's handles to refine. Better UX than silent failure.
    //
    // Honest limit: when no tile was hit we can't determine the
    // intended axis, so we default to 'axial' (the most common
    // analysis plane). User can switch to coronal/sagittal explicitly
    // by clicking into that pane first to move the crosshair there.
    if (!mm || !foundTile) {
      const cross = nv.scene?.crosshairPos;
      if (cross && typeof nv.frac2mm === 'function') {
        const fallback = nv.frac2mm(cross);
        if (fallback && fallback.length >= 3) {
          mm = [fallback[0]!, fallback[1]!, fallback[2]!];
          // axis stays whatever screenSlices resolved, or default 'axial'
        }
      }
      if (!mm) return null;
    }
    return { mm: [mm[0]!, mm[1]!, mm[2]!], axis };
  }

  /**
   * v0.7.8 — convert a source-mm point to canvas pixel coordinates.
   * Used by the new MeasurementsOverlay (SVG layer rendered over the
   * viewer canvas) to draw angle arms + persistent distance lines at
   * the correct pixel positions even as the user pans / zooms /
   * cycles slice indices.
   *
   * Returns null when:
   *   - the point doesn't fall on any of the currently visible MPR
   *     tiles (e.g. it's behind the active slice's depth)
   *   - NiiVue doesn't expose `frac2canvasPos` (older builds)
   *
   * The returned `tile` is one of `'axial' | 'coronal' | 'sagittal' |
   * '3d'` (or null if undetermined). Useful for filtering: a 2D
   * measurement only paints on the tile whose normal matches the
   * measurement's reference plane.
   */
  mmToCanvas(mm: [number, number, number]): {
    x: number;
    y: number;
    tile: 'axial' | 'coronal' | 'sagittal' | '3d' | null;
  } | null {
    const nv = this.nv as unknown as {
      mm2frac?(mm: [number, number, number]): [number, number, number];
      frac2canvasPos?(frac: [number, number, number]): [number, number] | null;
    };
    const frac = nv.mm2frac?.(mm);
    if (!frac) return null;
    const pos = nv.frac2canvasPos?.(frac);
    if (!pos) return null;
    return { x: pos[0], y: pos[1], tile: null };
  }

  /**
   * v0.7.8 — read NiiVue's per-pane layout. Returns one entry per
   * visible MPR tile with the tile's bounding rectangle in canvas
   * pixel coords + which axis it represents. Used by the per-pane
   * slice-number chip overlay so we can position one chip in the
   * top-left of each MPR viewport.
   *
   * NiiVue 0.44 stores this as `nv.screenSlices`, a private array of
   * objects with shape `{leftTopWidthHeight: [x, y, w, h], axCorSag:
   * 0|1|2|4}`. We adapt to that shape and return a typed view; if
   * NiiVue's internals change in a future version, the wrapper
   * insulates the React layer from the breakage.
   */
  getScreenSlices(): Array<{
    rect: [number, number, number, number];
    axis: 'axial' | 'coronal' | 'sagittal' | '3d';
    sliceIndex: number;
    sliceCount: number;
  }> {
    const nv = this.nv as unknown as {
      screenSlices?: Array<{
        leftTopWidthHeight?: number[];
        axCorSag?: number;
      }>;
      scene?: {
        crosshairPos?: [number, number, number];
      };
    };
    const slices = nv.screenSlices ?? [];
    if (this.primaryIndex < 0) return [];
    const v = this.nv.volumes[this.primaryIndex] as unknown as {
      hdr?: { dims: number[] };
    };
    const X = v?.hdr?.dims[1] ?? 1;
    const Y = v?.hdr?.dims[2] ?? 1;
    const Z = v?.hdr?.dims[3] ?? 1;
    const cross = nv.scene?.crosshairPos ?? [0.5, 0.5, 0.5];
    const out: Array<{
      rect: [number, number, number, number];
      axis: 'axial' | 'coronal' | 'sagittal' | '3d';
      sliceIndex: number;
      sliceCount: number;
    }> = [];
    for (const s of slices) {
      const rect = s.leftTopWidthHeight;
      if (!rect || rect.length !== 4) continue;
      // NiiVue's axCorSag mapping (from src/niivue.ts in upstream):
      //   0 = axial (Z), 1 = coronal (Y), 2 = sagittal (X), 4 = 3D render.
      let axis: 'axial' | 'coronal' | 'sagittal' | '3d';
      let sliceIndex: number;
      let sliceCount: number;
      switch (s.axCorSag) {
        case 0:
          axis = 'axial';
          sliceIndex = Math.round((cross[2] ?? 0.5) * (Z - 1));
          sliceCount = Z;
          break;
        case 1:
          axis = 'coronal';
          sliceIndex = Math.round((cross[1] ?? 0.5) * (Y - 1));
          sliceCount = Y;
          break;
        case 2:
          axis = 'sagittal';
          sliceIndex = Math.round((cross[0] ?? 0.5) * (X - 1));
          sliceCount = X;
          break;
        case 4:
          axis = '3d';
          sliceIndex = 0;
          sliceCount = 0;
          break;
        default:
          continue;
      }
      out.push({
        rect: [rect[0]!, rect[1]!, rect[2]!, rect[3]!],
        axis,
        sliceIndex,
        sliceCount,
      });
    }
    return out;
  }

  setMaskOutlineOnly(on: boolean): void {
    if (this.maskIndex < 0) return;
    const v = this.nv.volumes[this.maskIndex] as unknown as {
      img?: Uint8Array;
      hdr?: { dims: number[] };
    } | undefined;
    if (!v || !v.img || !v.hdr) return;
    const X = v.hdr.dims[1] ?? 0;
    const Y = v.hdr.dims[2] ?? 0;
    const Z = v.hdr.dims[3] ?? 0;
    if (X * Y * Z !== v.img.length) return;

    if (on) {
      if (!this.maskFilledVoxels) {
        // Stash the original filled voxels so we can restore on toggle off.
        this.maskFilledVoxels = new Uint8Array(v.img);
      }
      const src = this.maskFilledVoxels;
      const dst = v.img;
      const slab = X * Y;
      for (let z = 0; z < Z; z++) {
        for (let y = 0; y < Y; y++) {
          for (let x = 0; x < X; x++) {
            const i = z * slab + y * X + x;
            const cur = src[i]!;
            if (cur === 0) {
              dst[i] = 0;
              continue;
            }
            // Edge if any 6-neighbour is zero (or off-volume).
            const isEdge =
              x === 0 || src[i - 1] === 0 ||
              x === X - 1 || src[i + 1] === 0 ||
              y === 0 || src[i - X] === 0 ||
              y === Y - 1 || src[i + X] === 0 ||
              z === 0 || src[i - slab] === 0 ||
              z === Z - 1 || src[i + slab] === 0;
            dst[i] = isEdge ? cur : 0;
          }
        }
      }
    } else if (this.maskFilledVoxels) {
      v.img.set(this.maskFilledVoxels);
      this.maskFilledVoxels = null;
    }
    this.nv.updateGLVolume();
  }

  // ── Angle measurement ─────────────────────────────────────────────────────
  /**
   * Toggle the 3-click angle measurement mode. While on, the next three
   * canvas pointerups (handled in Viewer.tsx) are routed through
   * `addAnglePoint()` instead of NiiVue's own click handlers. Subscribers
   * registered via `onAngleUpdate()` are notified each time the state
   * changes (point added, mode reset, mode disabled).
   */
  setAngleMode(on: boolean): void {
    this.angleMode = on;
    // v0.7.5 — keep prior angle points on the canvas when the user
    // toggles the tool off. Pre-v0.7.5 we cleared them, which surprised
    // the user (they reported "the drawn angle and distances should
    // persist on screen unless clicked and deleted"). Now `clearAnglePoints`
    // is the only way to wipe — explicit user action.
    this.notifyAngle();
  }

  isAngleMode(): boolean {
    return this.angleMode;
  }

  /** Append a mm-space point to the angle measurement. No-op when off
   *  or when 3 points are already captured. */
  addAnglePoint(mm: [number, number, number]): void {
    if (!this.angleMode || this.anglePoints.length >= 3) return;
    this.anglePoints = [...this.anglePoints, mm];
    this.notifyAngle();
  }

  clearAnglePoints(): void {
    this.anglePoints = [];
    this.notifyAngle();
  }

  /**
   * v0.8.4 — synchronous getter for the current angle state. Used by
   * the Viewer's pointer-up handler so it can decide "did this click
   * complete the 3-point angle?" without registering a new
   * `onAngleUpdate` subscriber every click. The pre-v0.8.4 pattern
   * (register subscriber, unsub on first fire) raced badly with the
   * fact that `onAngleUpdate` fires the new subscriber **immediately**
   * with current state — on the first click the immediate fire
   * cancelled the subscriber before any subsequent click could trigger
   * it, so the third click never auto-committed and the user reported
   * "can't click second point for angle" / measurements not
   * persisting.
   */
  getAngleState(): AngleState {
    return this.snapshotAngle();
  }

  /** Subscribe to angle-state updates. Returns an unsubscribe fn. */
  onAngleUpdate(cb: (state: AngleState) => void): () => void {
    this.angleListeners.add(cb);
    // Fire once immediately so the new subscriber sees current state.
    cb(this.snapshotAngle());
    return () => this.angleListeners.delete(cb);
  }

  private snapshotAngle(): AngleState {
    const pts = this.anglePoints;
    if (pts.length < 3) {
      return { points: pts.slice(), degrees: null };
    }
    // Vector from vertex (pts[0]) to each arm endpoint.
    const v = pts[0]!;
    const a1: [number, number, number] = [pts[1]![0] - v[0], pts[1]![1] - v[1], pts[1]![2] - v[2]];
    const a2: [number, number, number] = [pts[2]![0] - v[0], pts[2]![1] - v[1], pts[2]![2] - v[2]];
    const dot = a1[0] * a2[0] + a1[1] * a2[1] + a1[2] * a2[2];
    const m1 = Math.hypot(a1[0], a1[1], a1[2]);
    const m2 = Math.hypot(a2[0], a2[1], a2[2]);
    if (m1 < 1e-6 || m2 < 1e-6) {
      return { points: pts.slice(), degrees: null };
    }
    const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
    return { points: pts.slice(), degrees: (Math.acos(cos) * 180) / Math.PI };
  }

  private notifyAngle(): void {
    const snap = this.snapshotAngle();
    this.angleListeners.forEach((fn) => fn(snap));
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
  // Capture the source NIfTI's sform rows so the AI mask can be written with
  // the same voxel→world affine and overlays correctly in NiiVue's MPR + 3D.
  const toSrow = (
    arr: number[] | undefined
  ): [number, number, number, number] | undefined =>
    arr && arr.length >= 4
      ? [arr[0]!, arr[1]!, arr[2]!, arr[3]!]
      : undefined;
  const srowX = toSrow(hdr?.srow_x);
  const srowY = toSrow(hdr?.srow_y);
  const srowZ = toSrow(hdr?.srow_z);
  const img = image.img;
  if (!img) throw new Error('NiiVue produced no voxel data for this volume.');
  const dtype = inferDtype(img);
  const voxels = img as
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint8Array
    | Float32Array;
  return {
    voxels,
    meta: {
      dims,
      spacing,
      origin,
      dtype,
      ...(srowX ? { srowX } : {}),
      ...(srowY ? { srowY } : {}),
      ...(srowZ ? { srowZ } : {}),
    },
  };
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
