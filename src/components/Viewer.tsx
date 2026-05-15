import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { NiivueViewer, type OverlayColorMap, type ProbeReading, type AngleState } from '../lib/viewer/niivue';
import { useAppStore } from '../lib/state/store';
import type { Bytes, VolumeMetadata } from '../types';

export type { ProbeReading };

export interface LoadedFromViewer {
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  meta: VolumeMetadata;
}

export interface ViewerHandle {
  loadPrimary(name: string, bytes: Bytes): Promise<LoadedFromViewer>;
  /** v0.7.4 — load a multi-file DICOM series into the primary slot. */
  loadPrimaryFromFiles(
    items: Array<{ name: string; bytes: Bytes }>
  ): Promise<LoadedFromViewer>;
  loadSecondary(name: string, bytes: Bytes, opacity?: number, colormap?: OverlayColorMap): Promise<LoadedFromViewer>;
  removeSecondary(): void;
  addMaskOverlay(
    name: string,
    mask: Uint8Array,
    dims: [number, number, number],
    spacing: [number, number, number],
    colormap?: OverlayColorMap,
    opacity?: number,
    affine?: {
      srowX?: [number, number, number, number];
      srowY?: [number, number, number, number];
      srowZ?: [number, number, number, number];
      origin?: [number, number, number];
    }
  ): Promise<void>;
  removeMaskOverlay(): void;
  /** v0.8.16 — drop every loaded volume + brush bitmap so the user
   *  can load a fresh series. Called by LoadedImagesList's Remove
   *  button. */
  unloadAll(): void;
  setMaskOpacity(opacity: number): void;
  setMaskColormap(colormap: OverlayColorMap): void;
  setWindow(level: number, width: number): void;
  setDrawingEnabled(on: boolean): void;
  setBrushLabel(label: number): void;
  setBrushOpacity(opacity: number): void;
  /** Brush radius in voxels (1..30). Applies to both brush + eraser. */
  setBrushRadius(radius: number): void;
  /** Wipe every painted voxel; subsequent strokes still work. */
  clearAllBrushStrokes(): void;
  /** Push current draw bitmap into the 3D mesh + redraw. Call on pointerup
   *  so the user's brush strokes appear in the volumetric render, not
   *  just the 2D MPR slices. */
  refreshDrawing(): void;
  /** Unconditional re-paint (no draw-mesh update). Used by the recovery
   *  handlers in this component so the canvas can repaint after WebGL
   *  context loss / cursor-leave even when the brush isn't active. */
  redraw(): void;
  /** v0.9.0 — toggle inverted colormap on the primary volume (OHIF "Invert"). */
  toggleInvert(): void;
  isInverted(): boolean;
  /** v0.9.0 — flip radiological/neurological convention (OHIF "Flip H"). */
  toggleRadiologicalConvention(): void;
  /** v0.9.0 — rotate the 3D render around the Z axis by `delta` degrees. */
  rotate3D(deltaAzimuth: number, deltaElevation?: number): void;
  undoLastBrushStroke(): void;
  /** Returns the AI mask merged with any user brush corrections, or null
   *  when no corrections have been drawn. */
  getCorrectedMask(aiMask: Uint8Array): Uint8Array | null;
  /** Returns the raw user brush layer (label per voxel; 0 = unpainted) so
   *  callers can split it by colour for per-label export. */
  getDrawnLayer(): Uint8Array | null;
  onProbe(listener: (r: ProbeReading | null) => void): () => void;
  // ── Layout / chrome ──
  setSliceMode(mode: 'multi' | 'axial' | 'coronal' | 'sagittal' | 'render'): void;
  setMultiplanarLayout(layout: 'auto' | 'column' | 'grid' | 'row'): void;
  setOrientCube(on: boolean): void;
  setColorbar(on: boolean): void;
  set3DCrosshair(on: boolean): void;
  setRadiologicalConvention(on: boolean): void;
  // ── Radiology tools ──
  setDragMode(mode: 'none' | 'contrast' | 'measurement' | 'pan'): void;
  /** v0.8.4 — read current drag mode without subscribing. */
  getDragMode(): 'none' | 'contrast' | 'measurement' | 'pan';
  setMaskOutlineOnly(on: boolean): void;
  resetView(): void;
  zoomBy(factor: number): void;
  /** Capture the canvas as a PNG; null when the GL context isn't ready. */
  takeScreenshot(): Promise<Blob | null>;
  /** v0.8.4 — capture only one MPR tile (axial / coronal / sagittal /
   *  3D render). Returns null when the requested tile isn't visible
   *  (e.g. user is in single-plane sliceMode). */
  takeScreenshotOfTile(
    axis: 'axial' | 'coronal' | 'sagittal' | '3d'
  ): Promise<Blob | null>;
  // ── Angle measurement (3-click) ──
  setAngleMode(on: boolean): void;
  isAngleMode(): boolean;
  addAnglePoint(mm: [number, number, number]): void;
  clearAnglePoints(): void;
  /** v0.8.4 — synchronous getter; lets the pointer-up handler decide
   *  whether to commit without subscribing+unsubbing per click. */
  getAngleState(): AngleState;
  onAngleUpdate(cb: (state: AngleState) => void): () => void;
  // ── SAM helpers ──
  /** Pull the current axial slice as Float32 grayscale + dims, for SAM
   *  encoding. Returns null when no primary volume is loaded. */
  getCurrentAxialSlice(): { pixels: Float32Array; width: number; height: number; index: number } | null;
  /** Same as getCurrentAxialSlice() but for a specific axial index. Used
   *  by SAM Phase D cross-slice propagation. Returns null when z is out
   *  of bounds or no primary volume is loaded. */
  getAxialSliceAt(
    z: number
  ): { pixels: Float32Array; width: number; height: number; index: number } | null;
  /** Map a click in canvas coords (relative to the overlay rect, which
   *  matches the canvas position) to source-axial-slice voxel coords.
   *  Returns null when the click is outside any slice tile. */
  canvasToAxialVoxel(canvasX: number, canvasY: number): { x: number; y: number } | null;
  /** v0.7.8 — convert a source-mm point to canvas pixel coordinates. */
  mmToCanvas(mm: [number, number, number]): {
    x: number;
    y: number;
    tile: 'axial' | 'coronal' | 'sagittal' | '3d' | null;
  } | null;
  /** v0.7.8 — read NiiVue's per-pane layout (one entry per visible
   *  MPR tile) for the slice-chip overlay. */
  getScreenSlices(): Array<{
    rect: [number, number, number, number];
    axis: 'axial' | 'coronal' | 'sagittal' | '3d';
    sliceIndex: number;
    sliceCount: number;
  }>;
  /** v0.8.5 — toggle NiiVue's native single-color crosshair. The
   *  axis-coloured crosshair overlay hides this and paints its own
   *  per-axis lines via SVG. */
  setNativeCrosshairVisible(visible: boolean): void;
  /** v0.8.5 — per-tile crosshair canvas-pixel position, for the
   *  axis-coloured crosshair SVG overlay. */
  getCrosshairTilePositions(): Array<{
    rect: [number, number, number, number];
    axis: 'axial' | 'coronal' | 'sagittal' | '3d';
    crosshair: { x: number; y: number };
  }>;
  /** v0.8.6 — read which mosaic tile a canvas-pixel point falls on
   *  (0=axial, 1=coronal, 2=sagittal, 3=3D, -1=gutter). Used by the
   *  per-pane crosshair lock. */
  tileIndexAt(canvasX: number, canvasY: number): number;
  /** v0.8.6 — capture the current crosshair fraction triple. */
  snapshotCrosshair(): [number, number, number];
  /** v0.8.6 — restore selected crosshair axes from a snapshot. */
  restoreCrosshairAxes(
    snapshot: [number, number, number],
    axes: [boolean, boolean, boolean]
  ): void;
  /** v0.8.6 — set 2D MPR zoom so 1 mm in the volume ≈ 1 mm on
   *  screen, using the user's calibrated `pxPerMm`. Returns the
   *  zoom multiplier applied. */
  fitOneToOne(pxPerMm: number): number;
}

export const Viewer = forwardRef<ViewerHandle>(function Viewer(_, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<NiivueViewer | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    viewerRef.current = new NiivueViewer(canvasRef.current);
    const onResize = () => viewerRef.current?.resize();
    window.addEventListener('resize', onResize);

    // Auto-refresh the 3D draw mesh after every brush stroke. NiiVue paints
    // straight into the 2D MPRs as the user drags but doesn't propagate to
    // the volumetric raycaster until refreshDrawing() runs. Tying that to
    // pointerup keeps the 3D view in lockstep without spamming a refresh on
    // every move event (which would tank framerate).
    const canvas = canvasRef.current;

    // Cache the most recent probe reading so the angle tool can capture
    // mm coordinates on pointerup without re-reading NiiVue's scene state.
    let lastMm: [number, number, number] | null = null;
    const probeUnsub = viewerRef.current?.onProbe((reading) => {
      lastMm = reading ? reading.mm : null;
    });

    /*
     * v0.8.4 — distance ruler persistence.
     *
     * NiiVue's measurement mode (dragMode='measurement') draws a line
     * between the pointer-down position and the current pointer
     * position during drag, then erases it on pointer-up — by design,
     * it's a single-shot measurement. The user reported "when a
     * distance is measured it does not persist." We capture the
     * pointer-down mm (start) and the pointer-up mm (end) and push a
     * `kind: 'distance'` measurement into the persistent store. The
     * MeasurementsOverlay SVG layer (v0.7.8) then re-paints them
     * across slice navigations, zooms, etc.
     *
     * `measureStartMm` is set on pointer-down only when dragMode
     * happens to be 'measurement' at that moment — checked by
     * reading the wrapper's `getDragMode()` snapshot. It's cleared
     * after every pointer-up so a subsequent click in default mode
     * doesn't accidentally produce a stray segment.
     */
    let measureStartMm: [number, number, number] | null = null;
    /*
     * v0.8.6 — per-pane crosshair lock state.
     *
     * The user reported "ax moving should be for the panel of series
     * which the cursor is on" and "can't move y axis smoothly". The
     * NiiVue default is: a click anywhere updates the 3D crosshair,
     * which moves all THREE axes simultaneously, so coronal +
     * sagittal slices change when the user only meant to scrub the
     * axial Z.
     *
     * Implementation: when Settings → "Per-pane crosshair lock" is
     * on, we snapshot the crosshair on `pointerdown` + record which
     * tile the click landed on. NiiVue then runs its normal click
     * → navigate logic. Right after (microtask), we restore the
     * snapshot on the OTHER two axes — leaving only the clicked
     * tile's plane updated.
     *
     *  - tile 0 (axial)    → only Z changes; restore [X, Y]
     *  - tile 1 (coronal)  → only Y changes; restore [X, Z]
     *  - tile 2 (sagittal) → only X changes; restore [Y, Z]
     *  - tile 3 (3D)       → no lock (clicks on the 3D render are
     *                        for orbit / no navigation)
     */
    let lockSnapshot: [number, number, number] | null = null;
    let lockTile = -1;
    const onPointerDown = (e: PointerEvent) => {
      const nv = viewerRef.current;
      if (nv?.getDragMode?.() === 'measurement' && lastMm) {
        measureStartMm = lastMm.slice() as [number, number, number];
      } else {
        measureStartMm = null;
      }
      // Per-pane crosshair lock — only on left button + only when
      // the Settings pref is on + only when not in a drag-tool mode
      // (drag-tools own the click; locking would fight pan/W-L).
      const lockEnabled = useAppStore.getState().prefs.perPaneCrosshairLock;
      if (
        lockEnabled &&
        e.button === 0 &&
        nv?.getDragMode?.() === 'none' &&
        nv?.snapshotCrosshair
      ) {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        // Account for devicePixelRatio — tileIndexAt expects canvas
        // pixel space which is CSS-px × DPR.
        const dpr = window.devicePixelRatio || 1;
        lockTile = nv.tileIndexAt(cx * dpr, cy * dpr);
        if (lockTile >= 0 && lockTile <= 2) {
          lockSnapshot = nv.snapshotCrosshair();
        } else {
          lockSnapshot = null;
        }
      } else {
        lockSnapshot = null;
        lockTile = -1;
      }
    };
    canvas.addEventListener('pointerdown', onPointerDown);

    const onPointerUp = (e: PointerEvent) => {
      // Brush propagation to 3D mesh.
      viewerRef.current?.refreshDrawing();
      /*
       * v0.8.6 — per-pane crosshair lock: restore the OTHER two axes
       * from the snapshot we took on pointer-down, leaving only the
       * clicked tile's plane updated. Runs on the next microtask so
       * NiiVue's click handler has finished writing its new
       * crosshairPos. Restored axes per tile:
       *   tile 0 (axial)    → restore [X, Y], leave Z
       *   tile 1 (coronal)  → restore [X, Z], leave Y
       *   tile 2 (sagittal) → restore [Y, Z], leave X
       */
      if (lockSnapshot && lockTile >= 0 && lockTile <= 2) {
        const restore: [boolean, boolean, boolean] =
          lockTile === 0
            ? [true, true, false]
            : lockTile === 1
              ? [true, false, true]
              : [false, true, true];
        const snap = lockSnapshot;
        queueMicrotask(() =>
          viewerRef.current?.restoreCrosshairAxes(snap, restore)
        );
      }
      lockSnapshot = null;
      lockTile = -1;
      // Angle measurement: only LEFT-button pointerups (e.button === 0)
      // count as angle-vertex captures. v0.7.2 captured every button so
      // a right-mouse W/L drag dropped a stray angle vertex on release;
      // worse, it made W/L feel "stuck" because the angle tool also
      // reset some internal state. Restricting to button 0 keeps the
      // right-drag W/L behaviour live while Angle is selected.
      const nv = viewerRef.current;
      if (
        e.button === 0 &&
        nv?.isAngleMode() &&
        lastMm
      ) {
        nv.addAnglePoint(lastMm);
        /*
         * v0.8.4 — auto-commit when the 3rd point lands.
         *
         * Pre-v0.8.4 used `onAngleUpdate(cb)` registered AFTER
         * `addAnglePoint()` and unsub'd on first fire. The wrapper
         * fires new subscribers IMMEDIATELY with current state, so
         * the unsub-on-first-fire trick raced with the click that
         * triggered it: the immediate fire hit `unsub()` before any
         * subsequent click could trigger the listener, and the
         * third click never auto-committed. The user reported "can't
         * click second point for angle" / measurements not persisting.
         *
         * Fixed by switching to the synchronous `getAngleState()`
         * getter — no subscriber dance. Read state right after
         * mutating it, commit when complete.
         */
        const s = nv.getAngleState();
        if (s.points.length === 3 && s.degrees !== null) {
          const id =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          useAppStore.getState().addMeasurement({
            id,
            kind: 'angle',
            vertex: s.points[0]!,
            arm1: s.points[1]!,
            arm2: s.points[2]!,
            degrees: s.degrees,
            addedAt: new Date().toISOString(),
          });
          nv.clearAnglePoints();
          // v0.8.5 — same redraw guard as the distance commit, in
          // case the angle store mutation triggers the same
          // canvas-blank race observed for distance.
          requestAnimationFrame(() => nv.redraw());
        }
      }

      /*
       * v0.8.4 — commit a distance measurement when measurement-mode
       * pointer-up lands on a point that's a non-trivial distance
       * from the pointer-down. Threshold (2 mm) filters accidental
       * stationary clicks; below that we just cleared the
       * measureStartMm without committing.
       */
      if (
        e.button === 0 &&
        measureStartMm &&
        lastMm &&
        nv?.getDragMode?.() === 'measurement'
      ) {
        const dx = lastMm[0] - measureStartMm[0];
        const dy = lastMm[1] - measureStartMm[1];
        const dz = lastMm[2] - measureStartMm[2];
        const distanceMm = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distanceMm >= 2) {
          const id =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          useAppStore.getState().addMeasurement({
            id,
            kind: 'distance',
            a: measureStartMm,
            b: lastMm.slice() as [number, number, number],
            distanceMm,
            addedAt: new Date().toISOString(),
          });
          /*
           * v0.8.5 — force a NiiVue redraw on the next animation frame
           * after committing the measurement. The user reported the
           * canvas going BLANK after a distance measurement (regression
           * from v0.8.4): NiiVue's measurement-mode pointerup leaves
           * the GL state in a configuration where the next React
           * render cycle (triggered by `addMeasurement` mutating the
           * zustand store + the MeasurementsOverlay re-render) erases
           * the canvas to backColor before the next drawScene tick.
           * Deferring `redraw()` past the React commit phase forces a
           * fresh paint that catches up.
           */
          requestAnimationFrame(() => nv.redraw());
        }
      }
      measureStartMm = null;
    };
    canvas.addEventListener('pointerup', onPointerUp);

    // Defensive recovery for v0.7.0 user reports of "viewer blanks when I use
    // a tool or right-click". On macOS WKWebView (Tauri) the WebGL context
    // can be evicted under memory pressure (large CT + 3D render + concurrent
    // SAM encoder); without explicit handling the canvas just stays at
    // backColor until the user reloads. Catching `webglcontextlost` lets us
    // suppress the default "permanent loss" behaviour, then `restored` calls
    // `drawScene()` so the volumes re-upload textures and the canvas repaints.
    const onContextLost = (e: Event) => {
      e.preventDefault(); // tells the browser the context is recoverable
      console.warn('[TAMIAS] WebGL context lost — will restore on next event');
    };
    const onContextRestored = () => {
      console.info('[TAMIAS] WebGL context restored — repainting');
      viewerRef.current?.redraw();
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);

    // Belt-and-suspenders: on `pointerleave` we trigger a no-op redraw
    // pass. NiiVue 0.44.x sometimes leaves the GL state in a configuration
    // where the next hover-redraw clears the canvas to backColor (the
    // v0.5.4 cursor-leave-blanks bug). Re-issuing drawScene() on leave
    // forces a fresh paint so the volumes stay visible until the user
    // re-enters the canvas.
    const onPointerLeave = () => {
      // Defer one frame so any in-flight pointer handler completes first.
      requestAnimationFrame(() => viewerRef.current?.redraw());
    };
    canvas.addEventListener('pointerleave', onPointerLeave);

    /**
     * v0.7.5 — wheel + pinch zoom on every viewport (2D MPR + 3D
     * render). Pre-v0.7.5 the user had to click the toolbar "Zoom in /
     * out" buttons, and even then NiiVue's `volScaleMultiplier` only
     * really felt active in the 3D pane. Trackpad pinch on macOS sends
     * `wheel` events with `ctrlKey: true`; mouse wheels send `wheel`
     * with no modifier. We treat both the same — multiply the existing
     * scale by `1 + 0.0015 * deltaY` (negative deltaY = scroll-up =
     * zoom in). The `passive: false` registration lets us
     * `preventDefault()` so the page doesn't also scroll.
     */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      /*
       * v0.8.4 — read pinch sensitivity + direction from prefs every
       * event so the user's Settings tweak applies immediately. No
       * useState mirror needed; getState is cheap.
       *
       * `pinchSensitivity` is a multiplier (0.5 = half the default,
       * 2.0 = double). `pinchInverted` flips the sign so users with
       * "natural" trackpad scrolling reversed (or who prefer the
       * opposite mental model) can swap in/out.
       */
      const prefs = useAppStore.getState().prefs;
      const sens = prefs.pinchSensitivity ?? 1;
      const inverted = prefs.pinchInverted ?? false;
      // Trackpad pinch (ctrlKey:true) gets 2× factor vs mouse wheel.
      const baseFactor = e.ctrlKey ? 0.003 : 0.0015;
      const sign = inverted ? -1 : 1;
      const ratio = Math.exp(-e.deltaY * baseFactor * sens * sign);
      const clamped = Math.max(0.5, Math.min(2, ratio));
      viewerRef.current?.zoomBy(clamped);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('wheel', onWheel);
      probeUnsub?.();
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      canvas.removeEventListener('webglcontextrestored', onContextRestored, false);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      async loadPrimaryFromFiles(items) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        return viewerRef.current.loadPrimaryFromFiles(items);
      },
      async loadPrimary(name, bytes) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        return viewerRef.current.loadPrimaryFromBytes(name, bytes);
      },
      async loadSecondary(name, bytes, opacity, colormap) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        return viewerRef.current.loadSecondaryFromBytes(name, bytes, opacity, colormap);
      },
      removeSecondary() {
        viewerRef.current?.removeSecondary();
      },
      async addMaskOverlay(name, mask, dims, spacing, colormap, opacity, affine) {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        await viewerRef.current.addMaskOverlay(name, mask, dims, spacing, colormap, opacity, affine);
      },
      removeMaskOverlay() {
        viewerRef.current?.removeMaskOverlay();
      },
      unloadAll() {
        viewerRef.current?.unloadAll();
      },
      setMaskOpacity(opacity) {
        viewerRef.current?.setMaskOpacity(opacity);
      },
      setMaskColormap(colormap) {
        viewerRef.current?.setMaskColormap(colormap);
      },
      setWindow(level, width) {
        viewerRef.current?.setWindow(level, width);
      },
      setDrawingEnabled(on) {
        viewerRef.current?.setDrawingEnabled(on);
      },
      setBrushLabel(label) {
        viewerRef.current?.setBrushLabel(label);
      },
      setBrushOpacity(opacity) {
        viewerRef.current?.setBrushOpacity(opacity);
      },
      setBrushRadius(radius) {
        viewerRef.current?.setBrushRadius(radius);
      },
      clearAllBrushStrokes() {
        viewerRef.current?.clearAllBrushStrokes();
      },
      refreshDrawing() {
        viewerRef.current?.refreshDrawing();
      },
      redraw() {
        viewerRef.current?.redraw();
      },
      toggleInvert() {
        viewerRef.current?.toggleInvert();
      },
      isInverted() {
        return viewerRef.current?.isInverted() ?? false;
      },
      toggleRadiologicalConvention() {
        viewerRef.current?.toggleRadiologicalConvention();
      },
      rotate3D(deltaAzimuth, deltaElevation = 0) {
        viewerRef.current?.rotate3D(deltaAzimuth, deltaElevation);
      },
      undoLastBrushStroke() {
        viewerRef.current?.undoLastBrushStroke();
      },
      getCorrectedMask(aiMask) {
        return viewerRef.current?.getCorrectedMask(aiMask) ?? null;
      },
      getDrawnLayer() {
        return viewerRef.current?.getDrawnLayer() ?? null;
      },
      onProbe(listener) {
        if (!viewerRef.current) return () => undefined;
        return viewerRef.current.onProbe(listener);
      },
      setSliceMode(mode) {
        viewerRef.current?.setSliceMode(mode);
      },
      setMultiplanarLayout(layout) {
        viewerRef.current?.setMultiplanarLayout(layout);
      },
      setOrientCube(on) {
        viewerRef.current?.setOrientCube(on);
      },
      setColorbar(on) {
        viewerRef.current?.setColorbar(on);
      },
      set3DCrosshair(on) {
        viewerRef.current?.set3DCrosshair(on);
      },
      setRadiologicalConvention(on) {
        viewerRef.current?.setRadiologicalConvention(on);
      },
      setDragMode(mode) {
        viewerRef.current?.setDragMode(mode);
      },
      getDragMode() {
        return viewerRef.current?.getDragMode() ?? 'none';
      },
      setMaskOutlineOnly(on) {
        viewerRef.current?.setMaskOutlineOnly(on);
      },
      resetView() {
        viewerRef.current?.resetView();
      },
      zoomBy(factor) {
        viewerRef.current?.zoomBy(factor);
      },
      async takeScreenshot() {
        return (await viewerRef.current?.takeScreenshot()) ?? null;
      },
      async takeScreenshotOfTile(axis) {
        return (await viewerRef.current?.takeScreenshotOfTile(axis)) ?? null;
      },
      setAngleMode(on) {
        viewerRef.current?.setAngleMode(on);
      },
      isAngleMode() {
        return viewerRef.current?.isAngleMode() ?? false;
      },
      addAnglePoint(mm) {
        viewerRef.current?.addAnglePoint(mm);
      },
      clearAnglePoints() {
        viewerRef.current?.clearAnglePoints();
      },
      getAngleState() {
        return (
          viewerRef.current?.getAngleState() ?? { points: [], degrees: null }
        );
      },
      onAngleUpdate(cb) {
        if (!viewerRef.current) return () => undefined;
        return viewerRef.current.onAngleUpdate(cb);
      },
      getCurrentAxialSlice() {
        return viewerRef.current?.getCurrentAxialSlice() ?? null;
      },
      getAxialSliceAt(z) {
        return viewerRef.current?.getAxialSliceAt(z) ?? null;
      },
      canvasToAxialVoxel(x, y) {
        return viewerRef.current?.canvasToAxialVoxel(x, y) ?? null;
      },
      mmToCanvas(mm) {
        return viewerRef.current?.mmToCanvas(mm) ?? null;
      },
      getScreenSlices() {
        return viewerRef.current?.getScreenSlices() ?? [];
      },
      setNativeCrosshairVisible(visible) {
        viewerRef.current?.setNativeCrosshairVisible(visible);
      },
      getCrosshairTilePositions() {
        return viewerRef.current?.getCrosshairTilePositions() ?? [];
      },
      tileIndexAt(canvasX, canvasY) {
        return viewerRef.current?.tileIndexAt(canvasX, canvasY) ?? -1;
      },
      snapshotCrosshair() {
        return viewerRef.current?.snapshotCrosshair() ?? [0.5, 0.5, 0.5];
      },
      restoreCrosshairAxes(snapshot, axes) {
        viewerRef.current?.restoreCrosshairAxes(snapshot, axes);
      },
      fitOneToOne(pxPerMm) {
        return viewerRef.current?.fitOneToOne(pxPerMm) ?? 1;
      },
    }),
    []
  );

  return (
    <div className="relative h-full w-full bg-black">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
});
