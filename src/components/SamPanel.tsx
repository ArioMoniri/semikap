import { useCallback, useState } from 'react';
import {
  Sparkles,
  Download,
  FolderOpen,
  Trash2,
  Plus,
  X as XIcon,
  Square,
  Type as TypeIcon,
  WandSparkles,
} from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import type { SamPrompt } from '../lib/sam/types';
import { ExternalLink } from './ExternalLink';

const SAM_DOC_URL = 'https://github.com/ArioMoniri/semikap/blob/main/docs/SAM.md';

/**
 * SAM (Segment Anything) onboarding + prompt UI. Three states:
 *
 *   1. No model loaded — show the three onboarding paths (pick from disk,
 *      download from HuggingFace, paste a custom URL) and a link to the
 *      implementation doc.
 *
 *   2. Model loading — progress + cancel.
 *
 *   3. Model ready — prompt UI: the active prompt mode (point / box / text),
 *      a list of accumulated prompts the user can selectively delete, and
 *      "Generate mask" / "Commit to mask" / "Clear" buttons.
 *
 * Wires through to the SAM worker (src/workers/sam.worker.ts). The worker
 * itself is currently a typed stub — see docs/SAM.md for the runtime
 * pipeline that's pending wiring against a concrete checkpoint.
 */
export function SamPanel() {
  const sam = useAppStore((s) => s.sam);
  const setSam = useAppStore((s) => s.setSam);
  const addPrompt = useAppStore((s) => s.addSamPrompt);
  const clearPrompts = useAppStore((s) => s.clearSamPrompts);
  const removePrompt = useAppStore((s) => s.removeSamPrompt);

  const [activeMode, setActiveMode] = useState<'point' | 'box' | 'text'>('point');
  const [textValue, setTextValue] = useState('');

  const handleAddText = useCallback(() => {
    if (!textValue.trim()) return;
    addPrompt({ kind: 'text', value: textValue.trim() });
    setTextValue('');
  }, [textValue, addPrompt]);

  return (
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
        {!sam.modelLoaded ? (
          <OnboardingView setSam={setSam} />
        ) : (
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
            forgetModel={() => setSam({ modelLoaded: false, modelName: null, prompts: [] })}
          />
        )}
        <Badge variant="warn" className="gap-1.5">
          <WandSparkles className="h-3 w-3" /> Bring your own SAM weights — see{' '}
          <ExternalLink href={SAM_DOC_URL} className="underline">
            docs/SAM.md
          </ExternalLink>{' '}
          for compatible HuggingFace exports.
        </Badge>
      </CardContent>
    </Card>
  );
}

function OnboardingView({
  setSam,
}: {
  setSam: (patch: { modelLoaded: boolean; modelName: string | null }) => void;
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
          onClick={() => alert('SAM model picker — runtime wiring pending. See docs/SAM.md.')}
        >
          <FolderOpen className="h-3.5 w-3.5" /> Pick local manifest + ONNX
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="justify-start gap-1.5"
          onClick={() => {
            // Placeholder — real impl prompts the user, fetches from HF,
            // hashes + caches in OPFS, then flips modelLoaded.
            const ok = confirm(
              'Download Xenova/medsam from HuggingFace?\n\n' +
                '~360 MB · Apache-2.0 · cached locally after download · no upload.\n\n' +
                "Runtime wiring is pending; this is a placeholder."
            );
            if (ok) setSam({ modelLoaded: true, modelName: 'Xenova/medsam (stub)' });
          }}
        >
          <Download className="h-3.5 w-3.5" /> Download from HuggingFace
        </Button>
      </div>
      <div className="text-[11px] text-slate-500">
        Recommended starter: <strong>SAM 2 Tiny</strong> (~30 MB encoder, runs
        on phones) or <strong>MedSAM</strong> (~360 MB, fine-tuned on medical
        imaging). Both offer the same prompt UX.
      </div>
    </div>
  );
}

function ReadyView(props: {
  activeMode: 'point' | 'box' | 'text';
  setActiveMode: (m: 'point' | 'box' | 'text') => void;
  textValue: string;
  setTextValue: (s: string) => void;
  handleAddText: () => void;
  prompts: SamPrompt[];
  removePrompt: (idx: number) => void;
  clearPrompts: () => void;
  modelName: string | null;
  forgetModel: () => void;
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
    forgetModel,
  } = props;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-emerald-50 px-2 py-1 dark:border-slate-800 dark:bg-emerald-950">
        <div className="flex min-w-0 items-center gap-1.5 text-emerald-800 dark:text-emerald-300">
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="truncate text-[11px]">{modelName ?? 'Model loaded'}</span>
        </div>
        <button
          type="button"
          onClick={forgetModel}
          aria-label="Forget loaded SAM model"
          className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
          title="Unload model"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      <div className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Prompt mode
        </div>
        <div className="grid grid-cols-3 gap-1">
          <ModeBtn
            label="Point"
            icon={<Plus className="h-3.5 w-3.5" />}
            active={activeMode === 'point'}
            onClick={() => setActiveMode('point')}
            hint="Click slice (shift-click = negative)"
          />
          <ModeBtn
            label="Box"
            icon={<Square className="h-3.5 w-3.5" />}
            active={activeMode === 'box'}
            onClick={() => setActiveMode('box')}
            hint="Drag a rectangle"
          />
          <ModeBtn
            label="Text"
            icon={<TypeIcon className="h-3.5 w-3.5" />}
            active={activeMode === 'text'}
            onClick={() => setActiveMode('text')}
            hint="SAM 3+ free-text prompts"
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
            No prompts yet — pick a mode and click on the slice.
          </div>
        ) : (
          <ul className="space-y-1">
            {prompts.map((p, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] dark:border-slate-800 dark:bg-slate-900"
              >
                <span className="min-w-0 truncate">
                  <PromptIcon kind={p.kind} />{' '}
                  <span className="font-mono text-slate-600 dark:text-slate-300">
                    {summarisePrompt(p)}
                  </span>
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

      <Button size="sm" variant="ink" disabled className="w-full gap-1.5">
        <Sparkles className="h-3.5 w-3.5" /> Generate mask (runtime pending)
      </Button>
    </div>
  );
}

function PromptIcon({ kind }: { kind: SamPrompt['kind'] }) {
  if (kind === 'point') return <Plus className="inline h-3 w-3 text-emerald-600" />;
  if (kind === 'box') return <Square className="inline h-3 w-3 text-blue-600" />;
  return <TypeIcon className="inline h-3 w-3 text-fuchsia-600" />;
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
  hint,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  hint: string;
}) {
  return (
    <Button
      size="sm"
      variant={active ? 'ink' : 'outline'}
      onClick={onClick}
      title={hint}
      className={`h-auto justify-start gap-1.5 px-2 py-1.5 text-[11px] ${
        active ? '' : 'text-slate-700 dark:text-slate-200'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}
