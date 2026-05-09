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

  /** Set the brush label index. Pass `0` for eraser. */
  setBrushLabel(label: number): void {
    (this.nv as unknown as NVDriver).setPenValue(label, true);
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
    const nv = this.nv as unknown as { scene?: { volScaleMultiplier?: number } };
    const cur = nv.scene?.volScaleMultiplier ?? 1;
    const next = Math.max(0.25, Math.min(16, cur * factor));
    if (nv.scene) nv.scene.volScaleMultiplier = next;
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
    // NiiVue 0.44 exposes a private `tileMM` helper that converts canvas
    // coords to source-mm — use it when available; otherwise fall back to
    // null so the caller falls back to a centre-click default.
    const mm = nv.tileMM?.(canvasX, canvasY);
    if (!mm) return null;
    const frac = nv.mm2frac?.(mm);
    if (!frac) return null;
    if (this.primaryIndex < 0) return null;
    const v = this.nv.volumes[this.primaryIndex] as unknown as { hdr?: { dims: number[] } };
    const X = v?.hdr?.dims[1] ?? 1;
    const Y = v?.hdr?.dims[2] ?? 1;
    return { x: Math.round(frac[0] * X), y: Math.round(frac[1] * Y) };
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
