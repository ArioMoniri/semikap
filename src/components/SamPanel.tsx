import { useCallback, useState } from 'react';
import * as Comlink from 'comlink';
import {
  Sparkles,
  Download,
  FolderOpen,
  Trash2,
  Plus,
  X as XIcon,
  Square,
  Type as TypeIcon,
  Wand2,
  Check,
} from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Progress } from './ui/Progress';
import type {
  SamPrompt,
  SamMaskResult,
  SamSliceEmbedding,
  SamManifest,
} from '../lib/sam/types';
import type { SamApi } from '../workers/sam.worker';
import { ExternalLink } from './ExternalLink';
import {
  PRESET_SAM_MODELS,
  loadSamModel,
  buildCustomSamManifest,
  type SamLoadProgress,
} from '../lib/sam/loader';
import { pickFile } from '../lib/fs/filesystem';
import { appendAudit } from '../lib/fs/audit';
import type { ViewerHandle } from './Viewer';
import { SamPromptOverlay } from './SamPromptOverlay';

const SAM_DOC_URL = 'https://github.com/ArioMoniri/semikap/blob/main/docs/SAM.md';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

/**
 * SAM (Segment Anything) panel.
 *
 * Three states (driven by `sam.modelLoaded` + `sam.busy`):
 *   1. No model loaded → onboarding (preset HuggingFace download + local
 *      file picker).
 *   2. Loading → progress bar + cancel.
 *   3. Ready → prompt mode chooser, prompt list, encode/decode buttons,
 *      preview-mask commit.
 *
 * The panel ALSO renders the SamPromptOverlay back into the viewer pane
 * when in an active prompt mode. The overlay listens for clicks and
 * pushes prompts directly into store state via addSamPrompt; the panel
 * just displays the resulting list.
 */
export function SamPanel({ viewerRef }: Props) {
  const sam = useAppStore((s) => s.sam);
  const setSam = useAppStore((s) => s.setSam);
  const removePrompt = useAppStore((s) => s.removeSamPrompt);
  const clearPrompts = useAppStore((s) => s.clearSamPrompts);
  const pushError = useAppStore((s) => s.pushError);

  const [activeMode, setActiveMode] = useState<'point' | 'box' | 'text' | 'off'>('off');
  const [textValue, setTextValue] = useState('');

  const handleAddText = useCallback(() => {
    if (!textValue.trim()) return;
    useAppStore.getState().addSamPrompt({ kind: 'text', value: textValue.trim() });
    setTextValue('');
  }, [textValue]);

  const handleDownloadPreset = useCallback(
    async (presetId: string) => {
      const preset = PRESET_SAM_MODELS.find((p) => p.id === presetId);
      if (!preset) return;
      // The "SAM 3 (bring-your-own URL)" preset has null URLs by design;
      // route it to the Custom URL onboarding flow so the user pastes their
      // own HuggingFace links. The BYO entry stays as a permanent escape
      // hatch even after community SAM 3 mirrors land — it lets users
      // point Tamias at any compatible ONNX export without an app rebuild.
      if (preset.manifest.encoder.url === null) {
        await runCustomUrlFlow(preset.manifest.family);
        return;
      }
      const sizeMB = (
        (preset.approxBytesEncoder + preset.approxBytesDecoder) /
        (1024 * 1024)
      ).toFixed(0);
      const ok = confirm(
        `Download ${preset.manifest.name} from HuggingFace?\n\n` +
          `~${sizeMB} MB · ${preset.manifest.license} · cached locally after download · no upload.\n\n` +
          'The download is one-shot; subsequent loads come from your browser cache (OPFS) and ' +
          'work offline.'
      );
      if (!ok) return;
      try {
        setSam({
          busy: { stage: 'fetching', label: 'Downloading encoder…', bytesLoaded: 0 },
        });
        const bytes = await loadSamModel(preset.manifest, (p: SamLoadProgress) => {
          setSam({
            busy: {
              stage: 'fetching',
              label:
                p.stage === 'encoder'
                  ? 'Downloading encoder…'
                  : p.stage === 'decoder'
                  ? 'Downloading decoder…'
                  : p.stage === 'verify'
                  ? 'Verifying…'
                  : p.stage === 'cache'
                  ? 'Caching to OPFS…'
                  : 'Done',
              bytesLoaded: p.bytesLoaded,
              ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}),
            },
          });
        });
        setSam({
          modelLoaded: true,
          modelName: preset.manifest.name,
          manifest: preset.manifest,
          encoderBytes: bytes.encoderBytes,
          decoderBytes: bytes.decoderBytes,
          embedding: null,
          preview: null,
          prompts: [],
          busy: null,
        });
        void appendAudit({
          kind: 'export',
          message: `SAM model loaded: ${preset.manifest.name}`,
          details: { family: preset.manifest.family, license: preset.manifest.license },
        });
      } catch (e) {
        const err = e as Error;
        pushError(`SAM download failed: ${err.message}`, err.stack ? { stack: err.stack } : undefined);
        setSam({ busy: null });
      }
    },
    // `runCustomUrlFlow` is intentionally omitted: it's declared below and
    // also memoised on `[setSam, pushError]`, so adding it would create a
    // declaration-order forward-reference without any behavioural change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setSam, pushError]
  );

  /**
   * Phase F — Custom URL onboarding. Prompts the user for a friendly
   * name + encoder URL + decoder URL, then runs the same load pipeline
   * as a preset. Used by the "SAM 3 (bring-your-own URL)" entry and the
   * standalone "Custom URL" button so any HuggingFace ONNX export can
   * be loaded without code changes.
   */
  const runCustomUrlFlow = useCallback(
    async (family?: 'sam' | 'sam2' | 'sam3' | 'medsam') => {
      const name = prompt('Friendly name for this SAM model:', 'My SAM');
      if (!name) return;
      const encoderUrl = prompt(
        'Encoder ONNX URL (e.g. HuggingFace resolve link):',
        'https://huggingface.co/.../encoder.onnx'
      );
      if (!encoderUrl) return;
      const decoderUrl = prompt(
        'Decoder ONNX URL:',
        'https://huggingface.co/.../decoder.onnx'
      );
      if (!decoderUrl) return;
      const manifest = buildCustomSamManifest({
        name,
        encoderUrl,
        decoderUrl,
        ...(family ? { family } : {}),
        expectsText: family === 'sam3',
      });
      try {
        setSam({
          busy: { stage: 'fetching', label: 'Downloading encoder…', bytesLoaded: 0 },
        });
        const bytes = await loadSamModel(manifest, (p: SamLoadProgress) => {
          setSam({
            busy: {
              stage: 'fetching',
              label:
                p.stage === 'encoder'
                  ? 'Downloading encoder…'
                  : p.stage === 'decoder'
                  ? 'Downloading decoder…'
                  : p.stage === 'verify'
                  ? 'Verifying…'
                  : p.stage === 'cache'
                  ? 'Caching to OPFS…'
                  : 'Done',
              bytesLoaded: p.bytesLoaded,
              ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}),
            },
          });
        });
        setSam({
          modelLoaded: true,
          modelName: name,
          manifest,
          encoderBytes: bytes.encoderBytes,
          decoderBytes: bytes.decoderBytes,
          embedding: null,
          preview: null,
          prompts: [],
          busy: null,
        });
        void appendAudit({
          kind: 'export',
          message: `SAM model loaded (custom URL): ${name}`,
          details: { family: manifest.family },
        });
      } catch (e) {
        const err = e as Error;
        pushError(
          `SAM custom-URL load failed: ${err.message}`,
          err.stack ? { stack: err.stack } : undefined
        );
        setSam({ busy: null });
      }
    },
    [setSam, pushError]
  );

  const handlePickLocal = useCallback(async () => {
    try {
      // 1) manifest.json
      const manifestFile = await pickFile({ 'application/json': ['.json'] });
      if (!manifestFile) return;
      const text = new TextDecoder().decode(manifestFile.bytes);
      const parsed = JSON.parse(text);
      if (parsed.kind !== 'sam') {
        throw new Error('Manifest is not a SAM manifest (missing `kind: "sam"`).');
      }
      // Lightweight cast — SAM manifest schema is documented in
      // src/lib/sam/types.ts and docs/SAM.md. Full schema-validation
      // lands alongside the existing parseManifest() in a follow-up.
      const manifest = parsed as SamManifest;

      // 2) encoder.onnx
      const enc = await pickFile({ 'application/octet-stream': ['.onnx'] });
      if (!enc) return;
      // 3) decoder.onnx
      const dec = await pickFile({ 'application/octet-stream': ['.onnx'] });
      if (!dec) return;

      setSam({
        modelLoaded: true,
        modelName: manifest.name ?? 'SAM (local)',
        manifest,
        encoderBytes: enc.bytes,
        decoderBytes: dec.bytes,
        embedding: null,
        preview: null,
        prompts: [],
        busy: null,
      });
      void appendAudit({
        kind: 'export',
        message: `SAM model loaded from disk: ${manifest.name ?? 'unnamed'}`,
      });
    } catch (e) {
      pushError(`SAM load failed: ${(e as Error).message}`);
    }
  }, [setSam, pushError]);

  const handleEncode = useCallback(async () => {
    if (!sam.modelLoaded || !sam.manifest || !sam.encoderBytes) return;
    const slice = viewerRef.current?.getCurrentAxialSlice();
    if (!slice) {
      pushError('No slice loaded — pick a primary volume first.');
      return;
    }
    setSam({ busy: { stage: 'encoding', label: `Encoding slice ${slice.index + 1}…` } });
    try {
      const worker = new Worker(new URL('../workers/sam.worker.ts', import.meta.url), {
        type: 'module',
      });
      const api = Comlink.wrap<SamApi>(worker);
      // Pass the raw Float32Array straight through — keeps full dynamic
      // range for CT (Hounsfield −1024..3072), MR, PT, MRA, etc. The
      // worker's preprocessSliceForSam auto-windows on 1st/99th
      // percentile internally, so any signed/unsigned int or float
      // typed array works as long as ArrayLike<number> is satisfied.
      // Quantising to uint8 here was destroying the dynamic range on
      // every CT (positives clipped at 255, negatives clipped at 0)
      // and producing degenerate masks.
      const res = (await api.encode({
        kind: 'encode',
        manifest: sam.manifest,
        encoderBytes: sam.encoderBytes,
        pixels: slice.pixels,
        inputMode: 'gray',
        width: slice.width,
        height: slice.height,
      })) as SamSliceEmbedding;
      worker.terminate();
      setSam({
        embedding: { axis: 'axial', index: slice.index, bytes: res.embedding },
        busy: null,
      });
      void appendAudit({
        kind: 'export',
        message: `SAM encode: slice ${slice.index + 1} in ${res.encodeMs.toFixed(0)}ms`,
      });
    } catch (e) {
      const err = e as Error;
      pushError(`SAM encode failed: ${err.message}`, err.stack ? { stack: err.stack } : undefined);
      setSam({ busy: null });
    }
  }, [sam, viewerRef, setSam, pushError]);

  const handleGenerate = useCallback(async () => {
    if (!sam.modelLoaded || !sam.manifest || !sam.decoderBytes || !sam.embedding) {
      pushError('Encode the slice first.');
      return;
    }
    if (sam.prompts.length === 0) {
      pushError('Add at least one prompt (click on the slice).');
      return;
    }
    const slice = viewerRef.current?.getCurrentAxialSlice();
    if (!slice) return;
    setSam({ busy: { stage: 'decoding', label: 'Generating mask…' } });
    try {
      const worker = new Worker(new URL('../workers/sam.worker.ts', import.meta.url), {
        type: 'module',
      });
      const api = Comlink.wrap<SamApi>(worker);
      const res = (await api.decode({
        kind: 'decode',
        manifest: sam.manifest,
        decoderBytes: sam.decoderBytes,
        embedding: sam.embedding.bytes,
        prompts: sam.prompts,
        width: slice.width,
        height: slice.height,
      })) as SamMaskResult;
      worker.terminate();
      setSam({
        preview: {
          mask: res.mask,
          width: res.width,
          height: res.height,
          score: res.score,
          sliceIndex: slice.index,
        },
        busy: null,
      });
      void appendAudit({
        kind: 'export',
        message: `SAM decode: ${(res.score * 100).toFixed(0)}% IoU in ${res.decodeMs.toFixed(0)}ms`,
      });
    } catch (e) {
      const err = e as Error;
      pushError(`SAM decode failed: ${err.message}`, err.stack ? { stack: err.stack } : undefined);
      setSam({ busy: null });
    }
  }, [sam, viewerRef, setSam, pushError]);

  const handleCommit = useCallback(async () => {
    if (!sam.preview) return;
    const volume = useAppStore.getState().volume;
    if (!volume || !viewerRef.current) return;
    const [X, Y, Z] = volume.meta.dims;
    if (sam.preview.width !== X || sam.preview.height !== Y) {
      pushError('Preview mask size does not match the volume — re-encode the slice.');
      return;
    }
    // Materialise the slice mask into a full-volume Uint8Array (zero
    // everywhere except the encoded slice, where we copy the SAM mask).
    const full = new Uint8Array(X * Y * Z);
    const slab = X * Y;
    const off = sam.preview.sliceIndex * slab;
    for (let i = 0; i < slab; i++) full[off + i] = sam.preview.mask[i] ?? 0;
    await viewerRef.current.addMaskOverlay(
      'sam',
      full,
      [X, Y, Z],
      volume.meta.spacing,
      'green',
      0.5,
      {
        ...(volume.meta.srowX ? { srowX: volume.meta.srowX } : {}),
        ...(volume.meta.srowY ? { srowY: volume.meta.srowY } : {}),
        ...(volume.meta.srowZ ? { srowZ: volume.meta.srowZ } : {}),
        origin: volume.meta.origin,
      }
    );
    setSam({ preview: null });
    void appendAudit({ kind: 'export', message: 'SAM mask committed to viewer' });
  }, [sam, viewerRef, setSam, pushError]);

  /**
   * Phase D — cross-slice propagation. Given the user has a committed
   * mask on slice N, we propagate to slices N±1..N±N_RADIUS by:
   *   1. Compute the bounding box of the current preview mask.
   *   2. For each neighbour slice z (alternating ±, growing outward):
   *        a. Pull the slice via getAxialSliceAt(z).
   *        b. Run encoder + decoder with the prior mask's bbox as a
   *           single box prompt.
   *        c. Stash the resulting mask into a multi-slice volume.
   *        d. Re-tighten the box for the next iteration so the prompt
   *           tracks the object as it moves slice-to-slice.
   *   3. Commit the multi-slice volume through addMaskOverlay.
   *
   * This is "best-effort" 2.5D propagation, not full SAM 2 video
   * tracking — there's no memory_attention. But for the common
   * radiology case (organ segmentation across ~20 slices) it produces a
   * usable multi-slice mask in seconds.
   */
  const handlePropagate = useCallback(
    async (radius: number) => {
      if (!sam.modelLoaded || !sam.manifest || !sam.encoderBytes || !sam.decoderBytes) {
        pushError('Load a SAM model first.');
        return;
      }
      if (!sam.preview || !sam.embedding) {
        pushError('Generate + commit a mask on the current slice first.');
        return;
      }
      const startZ = sam.preview.sliceIndex;
      const volume = useAppStore.getState().volume;
      if (!volume || !viewerRef.current) return;
      const [X, Y, Z] = volume.meta.dims;
      // 1) Initial bbox from the preview mask.
      const initialBox = bboxOfMask(sam.preview.mask, sam.preview.width, sam.preview.height);
      if (!initialBox) {
        pushError('Preview mask is empty — nothing to propagate.');
        return;
      }
      // 2) Build the multi-slice mask volume. Start with the existing
      //    preview slice copied in.
      const multi = new Uint8Array(X * Y * Z);
      const slab = X * Y;
      for (let i = 0; i < slab; i++) multi[startZ * slab + i] = sam.preview.mask[i] ?? 0;

      // Walk outwards: 1, -1, 2, -2, ... up to radius.
      const sliceOrder: number[] = [];
      for (let r = 1; r <= radius; r++) {
        if (startZ + r < Z) sliceOrder.push(startZ + r);
        if (startZ - r >= 0) sliceOrder.push(startZ - r);
      }

      const worker = new Worker(new URL('../workers/sam.worker.ts', import.meta.url), {
        type: 'module',
      });
      const api = Comlink.wrap<SamApi>(worker);

      let prevBox = initialBox;
      try {
        for (let i = 0; i < sliceOrder.length; i++) {
          const z = sliceOrder[i]!;
          setSam({
            busy: { stage: 'encoding', label: `Propagating ${i + 1}/${sliceOrder.length} (z=${z})…` },
          });
          const slice = viewerRef.current.getAxialSliceAt(z);
          if (!slice) continue;
          // Re-encode + decode with the prior bbox as a box prompt. Each
          // iteration spawns its own session inside the (cached) worker
          // — module-scope caching keeps cost amortised.
          const enc = await api.encode({
            kind: 'encode',
            manifest: sam.manifest,
            encoderBytes: sam.encoderBytes,
            pixels: slice.pixels,
            inputMode: 'gray',
            width: slice.width,
            height: slice.height,
          });
          const dec = await api.decode({
            kind: 'decode',
            manifest: sam.manifest,
            decoderBytes: sam.decoderBytes,
            embedding: enc.embedding,
            prompts: [
              { kind: 'box', xyxy: [prevBox.x0, prevBox.y0, prevBox.x1, prevBox.y1] },
            ],
            width: slice.width,
            height: slice.height,
          });
          // Stitch into the multi-slice volume.
          for (let j = 0; j < slab; j++) multi[z * slab + j] = dec.mask[j] ?? 0;
          // Re-tighten the box from the new mask. If the mask is empty
          // the object's gone (we've walked past the boundary) — stop
          // propagating in this direction.
          const nextBox = bboxOfMask(dec.mask, dec.width, dec.height);
          if (!nextBox) break;
          prevBox = nextBox;
        }
      } catch (e) {
        pushError(`Propagation failed: ${(e as Error).message}`);
      } finally {
        worker.terminate();
      }

      // 3) Commit the full multi-slice mask volume.
      await viewerRef.current.addMaskOverlay(
        'sam-propagated',
        multi,
        [X, Y, Z],
        volume.meta.spacing,
        'green',
        0.55,
        {
          ...(volume.meta.srowX ? { srowX: volume.meta.srowX } : {}),
          ...(volume.meta.srowY ? { srowY: volume.meta.srowY } : {}),
          ...(volume.meta.srowZ ? { srowZ: volume.meta.srowZ } : {}),
          origin: volume.meta.origin,
        }
      );
      setSam({ preview: null, busy: null });
      void appendAudit({
        kind: 'export',
        message: `SAM propagated mask across ${sliceOrder.length + 1} slices (z=${startZ} ±${radius})`,
      });
    },
    [sam, viewerRef, setSam, pushError]
  );

  const handleForget = useCallback(() => {
    setSam({
      modelLoaded: false,
      modelName: null,
      manifest: null,
      encoderBytes: null,
      decoderBytes: null,
      embedding: null,
      preview: null,
      prompts: [],
      busy: null,
    });
  }, [setSam]);

  return (
    <>
      {/* Click-capture overlay over the viewer. Only fires when the user
          is actively in a point/box prompt mode. */}
      {sam.modelLoaded && (
        <SamPromptOverlay viewerRef={viewerRef} mode={activeMode} />
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-tamias-accent" /> SAM (assisted)
            </CardTitle>
            <CardDescription>
              Click + box + text prompts → mask. Runs in your browser via WebGPU.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {sam.busy && <BusyView busy={sam.busy} />}

          {!sam.modelLoaded && !sam.busy && (
            <OnboardingView
              onPickLocal={handlePickLocal}
              onDownload={handleDownloadPreset}
              onCustomUrl={() => void runCustomUrlFlow()}
            />
          )}

          {sam.modelLoaded && !sam.busy && (
            <ReadyView
              activeMode={activeMode}
              setActiveMode={setActiveMode}
              textValue={textValue}
              setTextValue={setTextValue}
              handleAddText={handleAddText}
              prompts={sam.prompts}
              removePrompt={removePrompt}
              clearPrompts={clearPrompts}
              modelName={sam.modelName}
              forget={handleForget}
              encoded={!!sam.embedding}
              onEncode={handleEncode}
              onGenerate={handleGenerate}
              hasPreview={!!sam.preview}
              previewScore={sam.preview?.score ?? null}
              onCommit={handleCommit}
              onCancelPreview={() => setSam({ preview: null })}
              onPropagate={handlePropagate}
            />
          )}

          <Badge variant="warn" className="gap-1.5">
            See{' '}
            <ExternalLink href={SAM_DOC_URL} className="underline">
              docs/SAM.md
            </ExternalLink>{' '}
            for compatible HuggingFace exports + the BYOM contract.
          </Badge>
        </CardContent>
      </Card>
    </>
  );
}

function BusyView({ busy }: { busy: NonNullable<ReturnType<typeof useAppStore.getState>['sam']['busy']> }) {
  let pct = -1;
  if (busy.stage === 'fetching' && busy.bytesTotal) {
    pct = Math.round((busy.bytesLoaded / busy.bytesTotal) * 100);
  }
  return (
    <div className="space-y-1.5 rounded border border-blue-200 bg-blue-50 p-2 dark:border-blue-900 dark:bg-blue-950">
      <div className="text-[11px] font-medium text-blue-900 dark:text-blue-200">
        {busy.label}
      </div>
      {pct >= 0 ? (
        <Progress value={pct} />
      ) : (
        <div className="h-2 w-full animate-pulse rounded-full bg-blue-200" />
      )}
      {busy.stage === 'fetching' && (
        <div className="text-[10px] tabular-nums text-blue-800/70 dark:text-blue-200/60">
          {(busy.bytesLoaded / (1024 * 1024)).toFixed(1)} MB
          {busy.bytesTotal
            ? ` / ${(busy.bytesTotal / (1024 * 1024)).toFixed(1)} MB`
            : ''}
        </div>
      )}
    </div>
  );
}

function OnboardingView({
  onPickLocal,
  onDownload,
  onCustomUrl,
}: {
  onPickLocal: () => void;
  onDownload: (id: string) => void;
  onCustomUrl: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-slate-600 dark:text-slate-300">
        Pick or download a SAM checkpoint to enable click + box + text-prompted
        segmentation on the active slice. Same "no upload" guarantee as regular
        Tamias inference — once cached, the model runs entirely on your device.
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        <Button
          variant="ink"
          size="sm"
          className="justify-start gap-1.5"
          onClick={onPickLocal}
        >
          <FolderOpen className="h-3.5 w-3.5" /> Pick local manifest + ONNX
        </Button>
        {PRESET_SAM_MODELS.map((preset) => {
          const sizeMB = (
            (preset.approxBytesEncoder + preset.approxBytesDecoder) /
            (1024 * 1024)
          ).toFixed(0);
          const isBYO = preset.manifest.encoder.url === null;
          return (
            <Button
              key={preset.id}
              variant="outline"
              size="sm"
              className="justify-between gap-1.5"
              onClick={() => onDownload(preset.id)}
              title={
                isBYO
                  ? 'No bundled URL yet — opens the Custom URL flow.'
                  : `Stream ~${sizeMB} MB from HuggingFace into OPFS.`
              }
            >
              <span className="flex items-center gap-1.5">
                <Download className="h-3.5 w-3.5" /> {preset.manifest.name}
              </span>
              <span className="text-[10px] text-slate-500">
                {isBYO
                  ? 'BYO URL · ' + preset.manifest.license
                  : `~${sizeMB} MB · ${preset.manifest.license}`}
              </span>
            </Button>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          className="justify-start gap-1.5"
          onClick={onCustomUrl}
          title="Paste your own HuggingFace encoder + decoder URLs"
        >
          <FolderOpen className="h-3.5 w-3.5" /> Custom URL…
        </Button>
      </div>
      <div className="text-[11px] text-slate-500">
        Recommended starter: <strong>SAM 2 Tiny</strong> (~30 MB, runs on phones)
        or <strong>MedSAM</strong> (~360 MB, fine-tuned on medical imaging).
        For SAM 3 or any other compatible ONNX export, use the
        <strong> SAM 3 (bring-your-own URL)</strong> entry or the
        <strong> Custom URL…</strong> button to paste encoder + decoder links.
      </div>
    </div>
  );
}

function ReadyView(props: {
  activeMode: 'point' | 'box' | 'text' | 'off';
  setActiveMode: (m: 'point' | 'box' | 'text' | 'off') => void;
  textValue: string;
  setTextValue: (s: string) => void;
  handleAddText: () => void;
  prompts: SamPrompt[];
  removePrompt: (idx: number) => void;
  clearPrompts: () => void;
  modelName: string | null;
  forget: () => void;
  encoded: boolean;
  onEncode: () => void;
  onGenerate: () => void;
  hasPreview: boolean;
  previewScore: number | null;
  onCommit: () => void;
  onCancelPreview: () => void;
  /** Phase D — runs cross-slice propagation for ±radius slices. */
  onPropagate: (radius: number) => void;
}) {
  const {
    activeMode,
    setActiveMode,
    textValue,
    setTextValue,
    handleAddText,
    prompts,
    removePrompt,
    clearPrompts,
    modelName,
    forget,
    encoded,
    onEncode,
    onGenerate,
    hasPreview,
    previewScore,
    onCommit,
    onCancelPreview,
    onPropagate,
  } = props;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-emerald-50 px-2 py-1 dark:border-slate-800 dark:bg-emerald-950">
        <div className="flex min-w-0 items-center gap-1.5 text-emerald-800 dark:text-emerald-300">
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="truncate text-[11px]">{modelName ?? 'Model loaded'}</span>
          {encoded && (
            <Badge variant="ok" className="ml-1 text-[10px]">
              encoded
            </Badge>
          )}
        </div>
        <button
          type="button"
          onClick={forget}
          aria-label="Forget loaded SAM model"
          className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
          title="Unload model"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {!encoded && (
        <Button size="sm" variant="ink" onClick={onEncode} className="w-full gap-1.5">
          <Wand2 className="h-3.5 w-3.5" /> Encode current slice
        </Button>
      )}

      {encoded && (
        <>
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Prompt mode
            </div>
            <div className="grid grid-cols-4 gap-1">
              <ModeBtn
                label="Off"
                icon={<XIcon className="h-3.5 w-3.5" />}
                active={activeMode === 'off'}
                onClick={() => setActiveMode('off')}
              />
              <ModeBtn
                label="Point"
                icon={<Plus className="h-3.5 w-3.5" />}
                active={activeMode === 'point'}
                onClick={() => setActiveMode('point')}
              />
              <ModeBtn
                label="Box"
                icon={<Square className="h-3.5 w-3.5" />}
                active={activeMode === 'box'}
                onClick={() => setActiveMode('box')}
              />
              <ModeBtn
                label="Text"
                icon={<TypeIcon className="h-3.5 w-3.5" />}
                active={activeMode === 'text'}
                onClick={() => setActiveMode('text')}
              />
            </div>
          </div>

          {activeMode === 'text' && (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddText()}
                placeholder='e.g. "left kidney"'
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-900"
              />
              <Button size="sm" variant="outline" onClick={handleAddText} className="shrink-0">
                Add
              </Button>
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-slate-500">
              <span>Prompts ({prompts.length})</span>
              {prompts.length > 0 && (
                <button
                  type="button"
                  onClick={clearPrompts}
                  className="text-slate-500 hover:text-red-600"
                >
                  clear
                </button>
              )}
            </div>
            {prompts.length === 0 ? (
              <div className="text-[11px] text-slate-500">
                No prompts yet — pick Point / Box / Text and click on the slice.
              </div>
            ) : (
              <ul className="space-y-1">
                {prompts.map((p, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] dark:border-slate-800 dark:bg-slate-900"
                  >
                    <span className="min-w-0 truncate font-mono text-slate-600 dark:text-slate-300">
                      {summarisePrompt(p)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePrompt(i)}
                      aria-label={`Remove prompt ${i + 1}`}
                      className="rounded p-0.5 text-slate-400 hover:bg-red-100 hover:text-red-600"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Button
            size="sm"
            variant="ink"
            onClick={onGenerate}
            disabled={prompts.length === 0}
            className="w-full gap-1.5"
          >
            <Sparkles className="h-3.5 w-3.5" /> Generate mask
          </Button>

          {hasPreview && (
            <div className="space-y-1.5 rounded border border-emerald-300 bg-emerald-50 p-2 dark:border-emerald-800 dark:bg-emerald-950">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-emerald-900 dark:text-emerald-200">
                  Preview ready
                </span>
                {previewScore !== null && (
                  <Badge variant="ok" className="text-[10px]">
                    IoU {(previewScore * 100).toFixed(0)}%
                  </Badge>
                )}
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ink" onClick={onCommit} className="flex-1 gap-1.5">
                  <Check className="h-3.5 w-3.5" /> Commit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onCancelPreview}
                  className="flex-1 gap-1.5"
                >
                  <XIcon className="h-3.5 w-3.5" /> Cancel
                </Button>
              </div>
              {/* Phase D — cross-slice propagation. Two presets: ±5 for
                  a quick check, ±15 for a typical organ run. The loop
                  shows progress in the busy bar. */}
              <div className="space-y-1 border-t border-emerald-200 pt-1.5 dark:border-emerald-800/50">
                <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-900/70 dark:text-emerald-300/80">
                  Propagate (Phase D)
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPropagate(5)}
                    className="flex-1 gap-1.5"
                    title="Encode ±5 neighbour slices and use the prior mask's bbox as a box prompt"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> ±5 slices
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPropagate(15)}
                    className="flex-1 gap-1.5"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> ±15 slices
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Compute the tight bounding box of a binary mask. Returns null when
 * the mask is empty (no foreground pixels). Used by the Phase D
 * propagation loop to feed the prior-slice mask into the next slice's
 * decoder as a box prompt.
 */
function bboxOfMask(
  mask: Uint8Array,
  width: number,
  height: number
): { x0: number; y0: number; x1: number; y1: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

function summarisePrompt(p: SamPrompt): string {
  if (p.kind === 'point')
    return `point ${p.label === 1 ? '+' : '−'} (${Math.round(p.xy[0])}, ${Math.round(p.xy[1])})`;
  if (p.kind === 'box')
    return `box [${p.xyxy.map((n) => Math.round(n)).join(', ')}]`;
  return `text "${p.value}"`;
}

function ModeBtn({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={active ? 'ink' : 'outline'}
      onClick={onClick}
      className={`h-auto justify-center gap-1 px-1 py-1.5 text-[11px] ${
        active ? '' : 'text-slate-700 dark:text-slate-200'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}
