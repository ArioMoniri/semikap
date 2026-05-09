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
  CropIcon,
} from 'lucide-react';
import { useAppStore } from '../../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Progress } from '../ui/Progress';
import type {
  SamPrompt,
  SamMaskResult,
  SamSliceEmbedding,
  SamManifest,
} from '../../lib/sam/types';
import type { SamApi } from '../../workers/sam.worker';
import { ExternalLink } from '../ExternalLink';
import { PRESET_SAM_MODELS, loadSamModel, type SamLoadProgress } from '../../lib/sam/loader';
import { pickFile } from '../../lib/fs/filesystem';
import { appendAudit } from '../../lib/fs/audit';
import type { PathologyViewerHandle } from './PathologyViewer';
import { PathologySamOverlay } from './PathologySamOverlay';

const SAM_DOC_URL = 'https://github.com/ArioMoniri/semikap/blob/main/docs/SAM.md';
/** ROI side length in level-0 pixels. The encoder eats 1024², so larger
 *  ROIs lose detail but cover more anatomy per encode; smaller ROIs
 *  preserve detail at the cost of having to encode more often. We
 *  default to 4096² which is ~1× scale on a 4× lens at 0.25 µm/px. */
const DEFAULT_ROI_SIZE = 4096;

interface Props {
  viewerRef: React.MutableRefObject<PathologyViewerHandle | null>;
  /** Slide present? Disables most controls when there's no slide. */
  hasSlide: boolean;
}

export interface PathologyRoi {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * SAM panel for pathology mode. Mirrors `SamPanel` but operates in level-0
 * slide-pixel coordinates instead of voxel coordinates.
 *
 * UX flow:
 *   1. Load model (local files OR HuggingFace one-click).
 *   2. Pick ROI by clicking on the slide → centred 4096² rectangle in
 *      level-0 coords. The user can re-pick at any time.
 *   3. Encode ROI → reads a 1024² RGBA tile via PathologyViewerHandle's
 *      `readLevel0Region`, sends to the SAM worker with `inputMode: 'rgb'`.
 *   4. Prompts (point / box / text) — clicks captured by
 *      PathologySamOverlay, translated to level-0 pixel coords by the
 *      viewer, then mapped to the 1024² encoded patch by the worker.
 *   5. Generate mask → decoder runs against the cached embedding +
 *      prompts. Preview shows IoU score.
 *   6. Commit → mask written via `setMaskOverlay` covering the ROI.
 */
export function PathologySamPanel({ viewerRef, hasSlide }: Props) {
  const sam = useAppStore((s) => s.samPathology);
  const setSam = useAppStore((s) => s.setSamPathology);
  const removePrompt = useAppStore((s) => s.removeSamPathologyPrompt);
  const clearPrompts = useAppStore((s) => s.clearSamPathologyPrompts);
  const pushError = useAppStore((s) => s.pushError);

  const [activeMode, setActiveMode] = useState<'roi' | 'point' | 'box' | 'text' | 'off'>(
    'off'
  );
  const [textValue, setTextValue] = useState('');
  const [roiSize, setRoiSize] = useState<number>(DEFAULT_ROI_SIZE);

  const handleAddText = useCallback(() => {
    if (!textValue.trim()) return;
    useAppStore.getState().addSamPathologyPrompt({ kind: 'text', value: textValue.trim() });
    setTextValue('');
  }, [textValue]);

  const handleDownloadPreset = useCallback(
    async (presetId: string) => {
      const preset = PRESET_SAM_MODELS.find((p) => p.id === presetId);
      if (!preset) return;
      const sizeMB = (
        (preset.approxBytesEncoder + preset.approxBytesDecoder) /
        (1024 * 1024)
      ).toFixed(0);
      const ok = confirm(
        `Download ${preset.manifest.name} from HuggingFace?\n\n` +
          `~${sizeMB} MB · ${preset.manifest.license} · cached locally · no upload.`
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
          roi: null,
          busy: null,
        });
        void appendAudit({
          kind: 'export',
          message: `SAM model loaded (pathology): ${preset.manifest.name}`,
          details: { family: preset.manifest.family, license: preset.manifest.license },
        });
      } catch (e) {
        const err = e as Error;
        pushError(
          `SAM download failed: ${err.message}`,
          err.stack ? { stack: err.stack } : undefined
        );
        setSam({ busy: null });
      }
    },
    [setSam, pushError]
  );

  const handlePickLocal = useCallback(async () => {
    try {
      const manifestFile = await pickFile({ 'application/json': ['.json'] });
      if (!manifestFile) return;
      const text = new TextDecoder().decode(manifestFile.bytes);
      const parsed = JSON.parse(text);
      if (parsed.kind !== 'sam') throw new Error('Not a SAM manifest (kind != "sam").');
      const manifest = parsed as SamManifest;
      const enc = await pickFile({ 'application/octet-stream': ['.onnx'] });
      if (!enc) return;
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
        roi: null,
        busy: null,
      });
      void appendAudit({
        kind: 'export',
        message: `SAM model loaded from disk (pathology): ${manifest.name ?? 'unnamed'}`,
      });
    } catch (e) {
      pushError(`SAM load failed: ${(e as Error).message}`);
    }
  }, [setSam, pushError]);

  const handleEncodeRoi = useCallback(async () => {
    if (!sam.modelLoaded || !sam.manifest || !sam.encoderBytes || !sam.roi) return;
    setSam({
      busy: {
        stage: 'encoding',
        label: `Encoding ROI ${sam.roi.width}×${sam.roi.height} px…`,
      },
    });
    try {
      // Read a 1024² RGBA tile from the chosen level-0 ROI.
      const tile = await viewerRef.current?.readLevel0Region(
        sam.roi.x,
        sam.roi.y,
        sam.roi.width,
        sam.roi.height,
        1024,
        1024
      );
      if (!tile) throw new Error('Viewer not ready');
      const worker = new Worker(new URL('../../workers/sam.worker.ts', import.meta.url), {
        type: 'module',
      });
      const api = Comlink.wrap<SamApi>(worker);
      const res = (await api.encode({
        kind: 'encode',
        manifest: sam.manifest,
        encoderBytes: sam.encoderBytes,
        pixels: new Uint8Array(tile.rgba.buffer, tile.rgba.byteOffset, tile.rgba.byteLength),
        inputMode: 'rgb',
        width: tile.width,
        height: tile.height,
      })) as SamSliceEmbedding;
      worker.terminate();
      setSam({
        embedding: { axis: 'axial', index: 0, bytes: res.embedding },
        busy: null,
      });
      void appendAudit({
        kind: 'export',
        message: `SAM encode (pathology): ROI ${sam.roi.width}×${sam.roi.height} in ${res.encodeMs.toFixed(0)}ms`,
      });
    } catch (e) {
      const err = e as Error;
      pushError(
        `SAM encode failed: ${err.message}`,
        err.stack ? { stack: err.stack } : undefined
      );
      setSam({ busy: null });
    }
  }, [sam, viewerRef, setSam, pushError]);

  const handleGenerate = useCallback(async () => {
    if (
      !sam.modelLoaded ||
      !sam.manifest ||
      !sam.decoderBytes ||
      !sam.embedding ||
      !sam.roi
    ) {
      pushError('Pick a ROI and encode it first.');
      return;
    }
    if (sam.prompts.length === 0) {
      pushError('Add at least one prompt (click on the slide).');
      return;
    }
    // Map prompts from level-0 slide coords → ROI-local coords (the
    // worker already maps from "current width/height" to 1024² via its
    // internal scale).
    const localPrompts: SamPrompt[] = sam.prompts
      .map((p) => {
        if (p.kind === 'point') {
          return {
            kind: 'point',
            xy: [p.xy[0] - sam.roi!.x, p.xy[1] - sam.roi!.y],
            label: p.label,
          } as SamPrompt;
        }
        if (p.kind === 'box') {
          return {
            kind: 'box',
            xyxy: [
              p.xyxy[0] - sam.roi!.x,
              p.xyxy[1] - sam.roi!.y,
              p.xyxy[2] - sam.roi!.x,
              p.xyxy[3] - sam.roi!.y,
            ],
          } as SamPrompt;
        }
        return p;
      })
      // Filter out prompts that landed outside the ROI.
      .filter((p) => {
        if (p.kind === 'point') {
          return (
            p.xy[0] >= 0 && p.xy[0] < sam.roi!.width && p.xy[1] >= 0 && p.xy[1] < sam.roi!.height
          );
        }
        return true;
      });
    setSam({ busy: { stage: 'decoding', label: 'Generating mask…' } });
    try {
      const worker = new Worker(new URL('../../workers/sam.worker.ts', import.meta.url), {
        type: 'module',
      });
      const api = Comlink.wrap<SamApi>(worker);
      const res = (await api.decode({
        kind: 'decode',
        manifest: sam.manifest,
        decoderBytes: sam.decoderBytes,
        embedding: sam.embedding.bytes,
        prompts: localPrompts,
        // Worker treats width/height as the encoded-patch dims for
        // postprocess up-sample. We encoded at 1024² so the mask comes
        // out at 1024² and we layer it over the ROI proportionally.
        width: 1024,
        height: 1024,
      })) as SamMaskResult;
      worker.terminate();
      setSam({
        preview: {
          mask: res.mask,
          width: res.width,
          height: res.height,
          score: res.score,
          sliceIndex: 0,
        },
        busy: null,
      });
      void appendAudit({
        kind: 'export',
        message: `SAM decode (pathology): ${(res.score * 100).toFixed(0)}% IoU in ${res.decodeMs.toFixed(0)}ms`,
      });
    } catch (e) {
      const err = e as Error;
      pushError(
        `SAM decode failed: ${err.message}`,
        err.stack ? { stack: err.stack } : undefined
      );
      setSam({ busy: null });
    }
  }, [sam, setSam, pushError]);

  const handleCommit = useCallback(() => {
    if (!sam.preview || !sam.roi || !viewerRef.current) return;
    // Hand the mask to the OSD viewer's MaskOverlay. The buffer is the
    // 1024² mask; the OSD layer scales it across the ROI rect at render
    // time.
    viewerRef.current.setMaskOverlay({
      buffer: sam.preview.mask,
      width: sam.preview.width,
      height: sam.preview.height,
      level0X: sam.roi.x,
      level0Y: sam.roi.y,
      level0Width: sam.roi.width,
      level0Height: sam.roi.height,
      colors: { 1: '#22c55e' },
      isHeatmap: false,
      opacity: 0.55,
    });
    setSam({ preview: null });
    void appendAudit({ kind: 'export', message: 'SAM mask committed (pathology)' });
  }, [sam, viewerRef, setSam]);

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
      roi: null,
      busy: null,
    });
  }, [setSam]);

  /** Click-to-set-ROI handler — captures on the overlay, computes a
   *  centred rect in level-0 coords. */
  const handleSetRoi = useCallback(
    (x: number, y: number) => {
      const half = roiSize / 2;
      setSam({
        roi: {
          x: Math.max(0, Math.round(x - half)),
          y: Math.max(0, Math.round(y - half)),
          width: roiSize,
          height: roiSize,
        },
        embedding: null,
        preview: null,
        prompts: [],
      });
      setActiveMode('off');
    },
    [roiSize, setSam]
  );

  return (
    <>
      {sam.modelLoaded && hasSlide && (
        <PathologySamOverlay
          viewerRef={viewerRef}
          mode={activeMode}
          onSetRoi={handleSetRoi}
          roi={sam.roi ?? null}
        />
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-tamias-accent" /> SAM (assisted)
            </CardTitle>
            <CardDescription>
              Pick a ROI on the slide, then prompt (click + box + text) → mask. WebGPU.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {sam.busy && <BusyView busy={sam.busy} />}

          {!sam.modelLoaded && !sam.busy && (
            <OnboardingView onPickLocal={handlePickLocal} onDownload={handleDownloadPreset} />
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
              roi={sam.roi}
              roiSize={roiSize}
              setRoiSize={setRoiSize}
              encoded={!!sam.embedding}
              onEncode={handleEncodeRoi}
              onGenerate={handleGenerate}
              hasSlide={hasSlide}
              hasPreview={!!sam.preview}
              previewScore={sam.preview?.score ?? null}
              onCommit={handleCommit}
              onCancelPreview={() => setSam({ preview: null })}
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

function BusyView({
  busy,
}: {
  busy: NonNullable<ReturnType<typeof useAppStore.getState>['samPathology']['busy']>;
}) {
  let pct = -1;
  if (busy.stage === 'fetching' && busy.bytesTotal) {
    pct = Math.round((busy.bytesLoaded / busy.bytesTotal) * 100);
  }
  return (
    <div className="space-y-1.5 rounded border border-blue-200 bg-blue-50 p-2 dark:border-blue-900 dark:bg-blue-950">
      <div className="text-[11px] font-medium text-blue-900 dark:text-blue-200">{busy.label}</div>
      {pct >= 0 ? (
        <Progress value={pct} />
      ) : (
        <div className="h-2 w-full animate-pulse rounded-full bg-blue-200" />
      )}
      {busy.stage === 'fetching' && (
        <div className="text-[10px] tabular-nums text-blue-800/70 dark:text-blue-200/60">
          {(busy.bytesLoaded / (1024 * 1024)).toFixed(1)} MB
          {busy.bytesTotal ? ` / ${(busy.bytesTotal / (1024 * 1024)).toFixed(1)} MB` : ''}
        </div>
      )}
    </div>
  );
}

function OnboardingView({
  onPickLocal,
  onDownload,
}: {
  onPickLocal: () => void;
  onDownload: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-slate-600 dark:text-slate-300">
        Pick or download a SAM checkpoint to enable click + box + text-prompted segmentation
        on the active slide. Same "no upload" guarantee — once cached, the model runs entirely
        on your device.
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
          return (
            <Button
              key={preset.id}
              variant="outline"
              size="sm"
              className="justify-between gap-1.5"
              onClick={() => onDownload(preset.id)}
            >
              <span className="flex items-center gap-1.5">
                <Download className="h-3.5 w-3.5" /> {preset.manifest.name}
              </span>
              <span className="text-[10px] text-slate-500">
                ~{sizeMB} MB · {preset.manifest.license}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function ReadyView(props: {
  activeMode: 'roi' | 'point' | 'box' | 'text' | 'off';
  setActiveMode: (m: 'roi' | 'point' | 'box' | 'text' | 'off') => void;
  textValue: string;
  setTextValue: (s: string) => void;
  handleAddText: () => void;
  prompts: SamPrompt[];
  removePrompt: (idx: number) => void;
  clearPrompts: () => void;
  modelName: string | null;
  forget: () => void;
  roi: { x: number; y: number; width: number; height: number } | null;
  roiSize: number;
  setRoiSize: (n: number) => void;
  encoded: boolean;
  onEncode: () => void;
  onGenerate: () => void;
  hasSlide: boolean;
  hasPreview: boolean;
  previewScore: number | null;
  onCommit: () => void;
  onCancelPreview: () => void;
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
    roi,
    roiSize,
    setRoiSize,
    encoded,
    onEncode,
    onGenerate,
    hasSlide,
    hasPreview,
    previewScore,
    onCommit,
    onCancelPreview,
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

      {!hasSlide && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Load a slide first.
        </div>
      )}

      {hasSlide && (
        <>
          {/* ROI selector */}
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Region of interest (level-0 px)
            </div>
            <div className="flex items-center gap-1.5">
              <select
                value={roiSize}
                onChange={(e) => setRoiSize(Number(e.target.value))}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
              >
                <option value={1024}>1024 px</option>
                <option value={2048}>2048 px</option>
                <option value={4096}>4096 px</option>
                <option value={8192}>8192 px</option>
              </select>
              <Button
                size="sm"
                variant={activeMode === 'roi' ? 'ink' : 'outline'}
                onClick={() => setActiveMode(activeMode === 'roi' ? 'off' : 'roi')}
                className="gap-1.5"
              >
                <CropIcon className="h-3.5 w-3.5" />
                {activeMode === 'roi' ? 'Click slide…' : 'Pick ROI'}
              </Button>
            </div>
            {roi ? (
              <div className="text-[10px] text-slate-500 tabular-nums">
                ROI: ({roi.x}, {roi.y}) · {roi.width}×{roi.height}
              </div>
            ) : (
              <div className="text-[11px] text-slate-500">No ROI yet — click "Pick ROI" then click on the slide.</div>
            )}
          </div>

          {!encoded && roi && (
            <Button size="sm" variant="ink" onClick={onEncode} className="w-full gap-1.5">
              <Wand2 className="h-3.5 w-3.5" /> Encode ROI
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
                    placeholder='e.g. "tumour nuclei"'
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
                    Pick Point / Box / Text and click on the slide.
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
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
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
