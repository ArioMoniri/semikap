// OpenSeadragon-based whole-slide viewer.
//
// We bridge our `TileLoader` interface (which speaks RGBA bytes) to OSD's
// custom-tile-source contract by overriding `downloadTileStart` to return
// a freshly-painted off-screen canvas instead of letting OSD fetch a URL.
// This keeps every byte in-memory — same architectural commitment as the
// radiology side: no network, no upload.

import OpenSeadragon from 'openseadragon';
import type { TileLoader, SlideMetadata } from '../../types';

export type DragMode = 'pan' | 'distance' | 'brush' | 'eraser';

/** RGB triple for a brush colour. Same six-colour palette as the
 *  radiology brush so users get a consistent muscle memory across
 *  modalities. */
export const BRUSH_PALETTE: ReadonlyArray<{
  label: number;
  name: string;
  hex: string;
}> = [
  { label: 1, name: 'red', hex: '#ef4444' },
  { label: 2, name: 'green', hex: '#22c55e' },
  { label: 3, name: 'blue', hex: '#3b82f6' },
  { label: 4, name: 'yellow', hex: '#eab308' },
  { label: 5, name: 'cyan', hex: '#06b6d4' },
  { label: 6, name: 'magenta', hex: '#d946ef' },
];

export interface BrushStrokeSnapshot {
  /** Per-pixel label index (0 = unpainted). Same dimensions as the
   *  brush buffer. */
  buffer: Uint8Array;
}

export interface OsdViewerOptions {
  element: HTMLElement;
  loader: TileLoader;
  /** Tile size we ask OSD to request from us. Larger = fewer round trips
   *  but more wasted decode at edges; 512 is the sweet spot for most
   *  WSI viewers. */
  tileSize?: number;
}

export interface DistanceMeasurement {
  /** Length in slide microns (null when MPP unknown). */
  microns: number | null;
  /** Length in slide pixels (always available). */
  pixels: number;
  /** Endpoints in level-0 source pixels. */
  start: [number, number];
  end: [number, number];
}

export interface OsdViewer {
  /** Underlying OSD instance — exposed for advanced overlays (the brush
   *  layer, screenshot composition). */
  raw: OpenSeadragon.Viewer;
  meta: SlideMetadata;
  setDragMode(mode: DragMode): void;
  /** Listen for distance-tool measurements. Returns an unsubscribe fn. */
  onMeasure(listener: (m: DistanceMeasurement | null) => void): () => void;
  /** Listen for the cursor's slide-pixel position (for the readout). */
  onProbe(listener: (p: { px: [number, number]; mpp: [number, number] | null } | null) => void): () => void;
  fit(): void;
  zoomTo(factor: number): void;
  zoomBy(factor: number): void;
  oneToOne(): void;
  reset(): void;
  /** Render the current viewport (slide + overlays) to a Blob. */
  screenshot(): Promise<Blob | null>;
  /** Composite a per-pixel result onto the slide as a coloured overlay. */
  setMaskOverlay(overlay: MaskOverlay | null): void;
  // ── Brush API ──
  /** Set the active brush label (1..6) used while dragging in 'brush' mode. */
  setBrushLabel(label: number): void;
  /** Brush radius in slide-level-0 pixels. Driven by a UI slider. */
  setBrushRadius(radius: number): void;
  /** Pop the most recent stroke off the undo stack. */
  undoBrush(): void;
  /** Discard every brush stroke. */
  clearBrush(): void;
  /** Snapshot of the current brush buffer (for export). */
  getBrushBuffer(): {
    buffer: Uint8Array;
    width: number;
    height: number;
    /** Slide level-0 pixels covered by the brush canvas. */
    level0X: number;
    level0Y: number;
    level0Width: number;
    level0Height: number;
  };
  // ── SAM helpers (Phase B′) ──
  /**
   * Read a region of the slide at level-0 coordinates, downsampled to
   * (targetW × targetH). Used by the pathology SAM panel to feed the
   * encoder a 1024² RGBA tile of the user-picked ROI. Proxies straight
   * to the underlying TileLoader.readRegion.
   */
  readLevel0Region(
    level0X: number,
    level0Y: number,
    level0W: number,
    level0H: number,
    targetW: number,
    targetH: number
  ): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }>;
  /**
   * Convert a viewport-canvas click (in OSD canvas-pixel space) to
   * level-0 slide pixels. Used by the SAM prompt overlay to map clicks
   * into the same coordinate frame as ROI / mask overlays.
   */
  canvasToLevel0(canvasX: number, canvasY: number): { x: number; y: number } | null;
  destroy(): void;
}

export interface MaskOverlay {
  /** Result image (one byte per pixel, label index or score 0..255). */
  buffer: Uint8Array;
  /** Result image dimensions. */
  width: number;
  height: number;
  /** Region the result covers, level-0 source pixels. */
  level0X: number;
  level0Y: number;
  level0Width: number;
  level0Height: number;
  /** How to colour each label (or, for heatmap, the high-end colour). */
  colors: Record<number, string>;
  /** Treat buffer as continuous 0..255 score instead of label indices. */
  isHeatmap: boolean;
  /** Alpha 0..1 applied to coloured pixels. Background is left transparent. */
  opacity: number;
}

/** Build an OSD viewer + custom tile source wired to the given loader. */
export function createOsdViewer(opts: OsdViewerOptions): OsdViewer {
  const tileSize = opts.tileSize ?? 512;
  const meta = opts.loader.meta;

  // OSD level 0 is the LOWEST-resolution thumbnail; levels go up to the
  // native resolution. We expose `meta.levels` levels with downsamples
  // halving (or whatever the source reports). Convert downsamples to
  // OSD's 0..maxLevel orientation.
  const maxLevel = meta.levels - 1;

  const tileSource = buildCustomTileSource(opts.loader, tileSize);

  const viewer = OpenSeadragon({
    element: opts.element,
    showNavigationControl: false, // we ship our own toolbar
    showNavigator: true,
    navigatorAutoFade: true,
    navigatorBackground: '#0b1d3a',
    navigatorOpacity: 0.75,
    navigatorSizeRatio: 0.18,
    navigatorPosition: 'BOTTOM_RIGHT',
    immediateRender: false,
    preserveImageSizeOnResize: true,
    visibilityRatio: 0.5,
    constrainDuringPan: true,
    minZoomImageRatio: 0.5,
    maxZoomPixelRatio: 8,
    crossOriginPolicy: false, // disabled; we never use URLs
    ajaxWithCredentials: false,
    blendTime: 0.1,
    smoothTileEdgesMinZoom: Infinity, // disable; pathology wants pixel-exact
    showFullPageControl: false,
    tileSources: tileSource as unknown as OpenSeadragon.TileSourceOptions,
  });

  // ── Distance + probe state ────────────────────────────────────────────
  const measureListeners = new Set<(m: DistanceMeasurement | null) => void>();
  const probeListeners = new Set<
    (p: { px: [number, number]; mpp: [number, number] | null } | null) => void
  >();

  let dragMode: DragMode = 'pan';
  let measureStart: [number, number] | null = null;
  let measurePreviewEnd: [number, number] | null = null;

  // Layer canvas for the mask overlay + measurement line. OSD lets us
  // attach an overlay element that pans/zooms with the image.
  const overlayHost = document.createElement('div');
  overlayHost.style.position = 'absolute';
  overlayHost.style.inset = '0';
  overlayHost.style.pointerEvents = 'none';

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.style.position = 'absolute';
  overlayCanvas.style.inset = '0';
  overlayCanvas.style.width = '100%';
  overlayCanvas.style.height = '100%';
  overlayCanvas.style.pointerEvents = 'none';
  overlayHost.appendChild(overlayCanvas);

  // Append to the inner OSD container so it stacks above the tiled image
  // but below any navigator/control DOM.
  viewer.canvas.appendChild(overlayHost);

  let activeMaskOverlay: MaskOverlay | null = null;

  // ── Brush state ──────────────────────────────────────────────────────
  // We can't allocate a buffer at level-0 resolution (a 100k×100k slide
  // would need 10 GB of RGBA). The brush canvas is capped at 4096 px on
  // its long edge, mapped 1:1 to the slide's bounding rectangle. Brush
  // strokes paint at this coarser resolution; for histopathology the
  // user is correcting at zoomed-out levels anyway, so 25 µm precision
  // on a 0.25 µm/px slide is plenty.
  const BRUSH_MAX = 4096;
  const brushScale = Math.min(1, BRUSH_MAX / Math.max(meta.width, meta.height));
  const brushW = Math.max(1, Math.round(meta.width * brushScale));
  const brushH = Math.max(1, Math.round(meta.height * brushScale));
  const brushBuffer = new Uint8Array(brushW * brushH);
  const brushUndoStack: Uint8Array[] = [];
  const BRUSH_UNDO_LIMIT = 16;
  let brushLabel = 1;
  /** Brush radius in slide-level-0 pixels. Default = 24 px so a single
   *  click at 40× covers ~10 µm. */
  let brushRadius = 24;
  let brushStrokeActive = false;

  // Repaint the overlay canvas whenever the viewport moves or the mask
  // changes.
  const repaintOverlay = () => {
    const rect = viewer.canvas.getBoundingClientRect();
    if (overlayCanvas.width !== rect.width || overlayCanvas.height !== rect.height) {
      overlayCanvas.width = Math.max(1, Math.floor(rect.width));
      overlayCanvas.height = Math.max(1, Math.floor(rect.height));
    }
    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // Mask (AI inference result)
    if (activeMaskOverlay) drawMask(ctx, viewer, activeMaskOverlay);

    // Brush layer (user corrections) on top of the AI mask.
    drawBrush(ctx, viewer);

    // Measurement line
    if (dragMode === 'distance' && measureStart && measurePreviewEnd) {
      drawMeasurement(ctx, viewer, measureStart, measurePreviewEnd);
    }
  };

  viewer.addHandler('animation', repaintOverlay);
  viewer.addHandler('update-viewport', repaintOverlay);
  viewer.addHandler('zoom', repaintOverlay);
  viewer.addHandler('pan', repaintOverlay);
  viewer.addHandler('open', () => {
    repaintOverlay();
  });
  // Window resize → recompute backing-store size.
  const onResize = () => repaintOverlay();
  window.addEventListener('resize', onResize);

  // Mouse tracking for probe + measurement.
  const tracker = new OpenSeadragon.MouseTracker({
    element: viewer.element,
    moveHandler: (event) => {
      const e = event as { position?: OpenSeadragon.Point };
      if (!e.position) return;
      const vpPos = viewer.viewport.pointFromPixel(e.position);
      const imgPos = viewer.viewport.viewportToImageCoordinates(vpPos);
      const px: [number, number] = [imgPos.x, imgPos.y];
      probeListeners.forEach((fn) =>
        fn({
          px,
          mpp: meta.mppX !== null && meta.mppY !== null ? [meta.mppX, meta.mppY] : null,
        })
      );
      if (dragMode === 'distance' && measureStart) {
        measurePreviewEnd = px;
        repaintOverlay();
      }
      if ((dragMode === 'brush' || dragMode === 'eraser') && brushStrokeActive) {
        paintBrushAt(px[0], px[1], dragMode === 'eraser' ? 0 : brushLabel);
        repaintOverlay();
      }
    },
    pressHandler: (event) => {
      const e = event as { position?: OpenSeadragon.Point };
      if (!e.position) return;
      const vpPos = viewer.viewport.pointFromPixel(e.position);
      const imgPos = viewer.viewport.viewportToImageCoordinates(vpPos);

      if (dragMode === 'distance') {
        measureStart = [imgPos.x, imgPos.y];
        measurePreviewEnd = measureStart;
        repaintOverlay();
        return;
      }
      if (dragMode === 'brush' || dragMode === 'eraser') {
        // Snapshot for undo BEFORE we mutate the buffer, so popping
        // restores the pre-stroke state.
        pushBrushUndo();
        brushStrokeActive = true;
        paintBrushAt(imgPos.x, imgPos.y, dragMode === 'eraser' ? 0 : brushLabel);
        repaintOverlay();
        return;
      }
    },
    releaseHandler: (event) => {
      // End any in-flight brush stroke regardless of where the cursor is.
      if (brushStrokeActive) {
        brushStrokeActive = false;
      }
      if (dragMode !== 'distance' || !measureStart) return;
      const e = event as { position?: OpenSeadragon.Point };
      if (!e.position) return;
      const vpPos = viewer.viewport.pointFromPixel(e.position);
      const imgPos = viewer.viewport.viewportToImageCoordinates(vpPos);
      const end: [number, number] = [imgPos.x, imgPos.y];
      const dx = end[0] - measureStart[0];
      const dy = end[1] - measureStart[1];
      const pixels = Math.hypot(dx, dy);
      let microns: number | null = null;
      if (meta.mppX !== null && meta.mppY !== null) {
        microns = Math.hypot(dx * meta.mppX, dy * meta.mppY);
      }
      const m: DistanceMeasurement = {
        pixels,
        microns,
        start: measureStart,
        end,
      };
      measureListeners.forEach((fn) => fn(m));
      // Keep the line painted until the user starts a new one.
      measureStart = null;
      measurePreviewEnd = end;
      repaintOverlay();
    },
    leaveHandler: () => {
      probeListeners.forEach((fn) => fn(null));
    },
  });
  tracker.setTracking(true);

  return {
    raw: viewer,
    meta,
    setDragMode(mode) {
      dragMode = mode;
      // Built-in OSD panning is suppressed in every drag-tool mode so
      // the user's drag drives the tool, not the viewport.
      // `panHorizontal` / `panVertical` are valid OSD viewer fields but
      // missing from @types/openseadragon, so we cast.
      const v = viewer as unknown as {
        panHorizontal: boolean;
        panVertical: boolean;
      };
      const allowPan = mode === 'pan';
      v.panHorizontal = allowPan;
      v.panVertical = allowPan;
      // Reset any in-flight measurement when leaving distance mode.
      if (mode !== 'distance') {
        measureStart = null;
        measurePreviewEnd = null;
        measureListeners.forEach((fn) => fn(null));
        repaintOverlay();
      }
      brushStrokeActive = false;
    },
    onMeasure(fn) {
      measureListeners.add(fn);
      return () => measureListeners.delete(fn);
    },
    onProbe(fn) {
      probeListeners.add(fn);
      return () => probeListeners.delete(fn);
    },
    fit() {
      viewer.viewport.goHome(true);
    },
    zoomTo(factor) {
      viewer.viewport.zoomTo(factor, undefined, true);
      viewer.viewport.applyConstraints(true);
    },
    zoomBy(factor) {
      const z = viewer.viewport.getZoom();
      viewer.viewport.zoomTo(z * factor, undefined, false);
      viewer.viewport.applyConstraints(true);
    },
    oneToOne() {
      // 1:1 = one slide pixel per screen pixel. The viewport's image-pixel
      // ratio at zoom 1 is `viewer.viewport.imageToViewportZoom(1)`.
      const target = viewer.viewport.imageToViewportZoom(1);
      viewer.viewport.zoomTo(target, undefined, true);
    },
    reset() {
      viewer.viewport.goHome(false);
      activeMaskOverlay = null;
      measureStart = null;
      measurePreviewEnd = null;
      measureListeners.forEach((fn) => fn(null));
      repaintOverlay();
    },
    async screenshot() {
      // Compose: OSD's draw canvas + our overlay canvas.
      const drawer = (
        viewer as unknown as { drawer?: { canvas?: HTMLCanvasElement } }
      ).drawer;
      const tileCanvas = drawer?.canvas;
      if (!tileCanvas) return null;

      const out = document.createElement('canvas');
      out.width = tileCanvas.width;
      out.height = tileCanvas.height;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(tileCanvas, 0, 0);
      // Overlay canvas is sized in CSS pixels; rescale.
      ctx.drawImage(overlayCanvas, 0, 0, out.width, out.height);
      return new Promise<Blob | null>((res) => out.toBlob((b) => res(b), 'image/png'));
    },
    setMaskOverlay(overlay) {
      activeMaskOverlay = overlay;
      repaintOverlay();
    },
    setBrushLabel(label) {
      brushLabel = Math.max(1, Math.min(BRUSH_PALETTE.length, Math.round(label)));
    },
    setBrushRadius(radius) {
      brushRadius = Math.max(1, Math.round(radius));
    },
    undoBrush() {
      const prev = brushUndoStack.pop();
      if (!prev) return;
      brushBuffer.set(prev);
      invalidateBrushCache();
      repaintOverlay();
    },
    clearBrush() {
      pushBrushUndo();
      brushBuffer.fill(0);
      invalidateBrushCache();
      repaintOverlay();
    },
    getBrushBuffer() {
      return {
        buffer: brushBuffer,
        width: brushW,
        height: brushH,
        level0X: 0,
        level0Y: 0,
        level0Width: meta.width,
        level0Height: meta.height,
      };
    },
    async readLevel0Region(level0X, level0Y, level0W, level0H, targetW, targetH) {
      // Defer straight to the loader so SAM doesn't have to know which
      // tile-source backend is active (OME-TIFF / single-file / TIFF
      // fallback). The loader returns a TileBitmap with rgba bytes.
      const tile = await opts.loader.readRegion(
        level0X,
        level0Y,
        level0W,
        level0H,
        targetW,
        targetH
      );
      return { rgba: tile.rgba, width: tile.width, height: tile.height };
    },
    canvasToLevel0(canvasX, canvasY) {
      // OSD's viewport API converts canvas pixels → viewport coords →
      // image coords. Image coords are normalised 0..1 across the slide
      // width; multiply by level-0 dims to land in slide pixels.
      try {
        const point = new OpenSeadragon.Point(canvasX, canvasY);
        const viewportPoint = viewer.viewport.pointFromPixel(point);
        const imgPoint = viewer.viewport.viewportToImageCoordinates(viewportPoint);
        const x = imgPoint.x;
        const y = imgPoint.y;
        if (x < 0 || y < 0 || x > meta.width || y > meta.height) return null;
        return { x: Math.round(x), y: Math.round(y) };
      } catch {
        return null;
      }
    },
    destroy() {
      window.removeEventListener('resize', onResize);
      tracker.destroy();
      try {
        viewer.destroy();
      } catch {
        /* OSD throws on double-destroy in some versions */
      }
      opts.loader.dispose();
    },
  };

  // ── helpers ────────────────────────────────────────────────────────

  function buildCustomTileSource(
    loader: TileLoader,
    ts: number
  ): OpenSeadragon.TileSource {
    // OSD level 0 is the LOWEST-res view in OpenSeadragon convention.
    // Our loader exposes levels in OpenSlide convention (0 = highest-res).
    // The OSD tile source maps OSD level → loader level inside readTile.
    // OSD's TileSourceOptions doesn't list getTileUrl in @types/openseadragon
    // even though the runtime accepts it (every custom tile source does this).
    // Cast through unknown so TS lets us pass the closure.
    const sourceOpts = {
      width: meta.width,
      height: meta.height,
      tileSize: ts,
      tileOverlap: 0,
      minLevel: 0,
      maxLevel,
      // getTileUrl is required by OSD's contract. We return a placeholder
      // that's never fetched — downloadTileStart short-circuits the
      // pipeline before OSD touches the URL.
      getTileUrl: (level: number, x: number, y: number) =>
        `tile://${level}/${x}/${y}`,
    } as unknown as OpenSeadragon.TileSourceOptions;
    const source = new OpenSeadragon.TileSource(sourceOpts);

    // Override download. OSD's tile pipeline gives us an `ImageJob`; we
    // call `finish(canvas)` with our own painted canvas, and OSD treats
    // the canvas as the tile data.
    source.downloadTileStart = (job) => {
      const u = String(job.src);
      const m = /^tile:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(u);
      if (!m) {
        job.fail('Malformed tile URL', null);
        return;
      }
      const level = Number(m[1]);
      const col = Number(m[2]);
      const row = Number(m[3]);
      void loader
        .readTile(level, col, row, ts)
        .then((bm) => {
          if (bm.width === 0 || bm.height === 0) {
            job.fail('Empty tile', null);
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = bm.width;
          canvas.height = bm.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            job.fail('No 2D context', null);
            return;
          }
          ctx.putImageData(makeImageData(bm.rgba, bm.width, bm.height), 0, 0);
          job.finish(canvas, null, 'context2d');
        })
        .catch((e: Error) => {
          job.fail(e.message, null);
        });
    };
    source.downloadTileAbort = () => {
      // We can't currently cancel an in-flight readTile (geotiff.js uses
      // its own AbortSignal but we'd have to plumb it through). Letting
      // the promise resolve naturally is fine — the result just gets
      // discarded by OSD's tile cache.
    };

    return source;
  }

  // ── Brush helpers (closure scope) ───────────────────────────────────
  let brushCachedCanvas: HTMLCanvasElement | null = null;

  function invalidateBrushCache(): void {
    brushCachedCanvas = null;
  }

  /** Stamp a filled disc onto the brush buffer at slide-pixel (x, y).
   *  Called both on press (single click → single dot) and on every
   *  move event during a drag, so the user sees a continuous stroke. */
  function paintBrushAt(slideX: number, slideY: number, label: number): void {
    // Translate from slide level-0 px → brush-buffer px.
    const cx = slideX * brushScale;
    const cy = slideY * brushScale;
    const rBrush = Math.max(1, brushRadius * brushScale);
    const r2 = rBrush * rBrush;
    const x0 = Math.max(0, Math.floor(cx - rBrush));
    const x1 = Math.min(brushW, Math.ceil(cx + rBrush));
    const y0 = Math.max(0, Math.floor(cy - rBrush));
    const y1 = Math.min(brushH, Math.ceil(cy + rBrush));
    for (let y = y0; y < y1; y++) {
      const dy = y - cy;
      for (let x = x0; x < x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) {
          brushBuffer[y * brushW + x] = label;
        }
      }
    }
    invalidateBrushCache();
  }

  function pushBrushUndo(): void {
    const snap = new Uint8Array(brushBuffer.length);
    snap.set(brushBuffer);
    brushUndoStack.push(snap);
    while (brushUndoStack.length > BRUSH_UNDO_LIMIT) {
      brushUndoStack.shift();
    }
  }

  function drawBrush(
    ctx: CanvasRenderingContext2D,
    v: OpenSeadragon.Viewer
  ): void {
    if (!brushCachedCanvas) {
      // Build a fresh canvas from the brush buffer using the palette.
      const c = document.createElement('canvas');
      c.width = brushW;
      c.height = brushH;
      const cctx = c.getContext('2d');
      if (!cctx) return;
      const img = new ImageData(brushW, brushH);
      const palette = compileBrushPalette();
      for (let i = 0; i < brushBuffer.length; i++) {
        const lab = brushBuffer[i] as number;
        if (lab === 0) {
          img.data[i * 4 + 3] = 0;
          continue;
        }
        const rgb = palette[lab];
        if (!rgb) {
          img.data[i * 4 + 3] = 0;
          continue;
        }
        img.data[i * 4] = rgb[0];
        img.data[i * 4 + 1] = rgb[1];
        img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = 220;
      }
      cctx.putImageData(img, 0, 0);
      brushCachedCanvas = c;
    }

    const tl = v.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(0, 0)
    );
    const br = v.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(meta.width, meta.height)
    );
    const w = br.x - tl.x;
    const h = br.y - tl.y;
    if (w <= 0 || h <= 0) return;

    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(brushCachedCanvas, tl.x, tl.y, w, h);
    ctx.restore();
  }

  function compileBrushPalette(): Record<number, [number, number, number]> {
    const out: Record<number, [number, number, number]> = {};
    for (const c of BRUSH_PALETTE) {
      out[c.label] = parseHex(c.hex);
    }
    return out;
  }

  function drawMeasurement(
    ctx: CanvasRenderingContext2D,
    v: OpenSeadragon.Viewer,
    p0: [number, number],
    p1: [number, number]
  ): void {
    const a = v.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(p0[0], p0[1])
    );
    const b = v.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(p1[0], p1[1])
    );
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fbbf24'; // amber — readable on H&E and IHC
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // End caps
    for (const pt of [a, b]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Label
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const px = Math.hypot(dx, dy);
    let label = `${px.toFixed(0)} px`;
    if (meta.mppX !== null && meta.mppY !== null) {
      const microns = Math.hypot(dx * meta.mppX, dy * meta.mppY);
      label = microns >= 1000 ? `${(microns / 1000).toFixed(2)} mm` : `${microns.toFixed(1)} µm`;
    }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(mid.x - w / 2, mid.y - 10, w, 20);
    ctx.fillStyle = '#fde68a';
    ctx.fillText(label, mid.x, mid.y);
    ctx.restore();
  }

  function drawMask(
    ctx: CanvasRenderingContext2D,
    v: OpenSeadragon.Viewer,
    overlay: MaskOverlay
  ): void {
    // Map ROI corners to viewer-element pixels.
    const tl = v.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(overlay.level0X, overlay.level0Y)
    );
    const br = v.viewport.imageToViewerElementCoordinates(
      new OpenSeadragon.Point(
        overlay.level0X + overlay.level0Width,
        overlay.level0Y + overlay.level0Height
      )
    );

    // Build the mask as an off-screen canvas then drawImage with bilinear
    // resampling. Cached via WeakMap so we don't repaint on every frame.
    let cached = (overlay as MaskOverlay & { __cached?: HTMLCanvasElement }).__cached;
    if (!cached) {
      cached = document.createElement('canvas');
      cached.width = overlay.width;
      cached.height = overlay.height;
      const cctx = cached.getContext('2d');
      if (!cctx) return;
      const img = new ImageData(overlay.width, overlay.height);
      paintMaskRgba(overlay, img.data);
      cctx.putImageData(img, 0, 0);
      (overlay as MaskOverlay & { __cached?: HTMLCanvasElement }).__cached = cached;
    }

    const w = br.x - tl.x;
    const h = br.y - tl.y;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.globalAlpha = overlay.opacity;
    ctx.imageSmoothingEnabled = false; // pixel-exact; up to caller to re-enable
    ctx.drawImage(cached, tl.x, tl.y, w, h);
    ctx.restore();
  }
}

/** Build an `ImageData` from a Uint8ClampedArray whose buffer might be
 *  shared. TS-5.7 narrowed `Uint8ClampedArray.buffer` to `ArrayBufferLike`,
 *  which the `ImageData` constructor no longer accepts; copy when needed. */
function makeImageData(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): ImageData {
  if (rgba.buffer instanceof ArrayBuffer) {
    return new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height);
  }
  const safe = new Uint8ClampedArray(rgba.byteLength);
  safe.set(rgba);
  return new ImageData(safe, width, height);
}

function paintMaskRgba(overlay: MaskOverlay, out: Uint8ClampedArray): void {
  const palette = compilePalette(overlay.colors);
  if (overlay.isHeatmap) {
    const high = overlay.colors[1] ?? '#ff0040';
    const [hr, hg, hb] = parseHex(high);
    for (let i = 0; i < overlay.buffer.length; i++) {
      const s = overlay.buffer[i] as number;
      out[i * 4] = hr;
      out[i * 4 + 1] = hg;
      out[i * 4 + 2] = hb;
      out[i * 4 + 3] = s; // 0..255 score doubles as alpha
    }
    return;
  }
  for (let i = 0; i < overlay.buffer.length; i++) {
    const label = overlay.buffer[i] as number;
    if (label === 0) {
      out[i * 4 + 3] = 0;
      continue;
    }
    const c = palette[label] ?? [0, 0, 0];
    out[i * 4] = c[0]!;
    out[i * 4 + 1] = c[1]!;
    out[i * 4 + 2] = c[2]!;
    out[i * 4 + 3] = 200;
  }
}

function compilePalette(
  colors: Record<number, string>
): Record<number, [number, number, number]> {
  const out: Record<number, [number, number, number]> = {};
  for (const [k, v] of Object.entries(colors)) {
    out[Number(k)] = parseHex(v);
  }
  return out;
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 0, 64];
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
