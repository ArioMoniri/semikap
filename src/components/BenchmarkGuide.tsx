/**
 * Collapsible "how to benchmark" stepper. Two tracks matching the two input
 * modes — run models on images, or import already-computed results — so a new
 * user always knows the next click. Pure presentational, no state beyond open.
 */

import { useState } from 'react';
import { HelpCircle, ChevronDown, ChevronRight } from 'lucide-react';

const IMAGE_STEPS = [
  'Register two ONNX models (Your models → pick .onnx + manifest .json → Register). Or load an Example kit.',
  'Single image: load a volume in the viewer, run a model, capture a Reference (ground truth or a model output), then Score vs reference.',
  'Many images: in "Batch", select ~20 images (and optional ground-truth masks, named to match), pick Model A and Model B, and Run batch.',
  'Flip through cases with "view" to see where the two models disagree (blue = only A, pink = only B, green = agree).',
  'Read the Comparison table (mean Dice/IoU/HD95 per model) and the Statistical comparison (corrected t-test / Wilcoxon / Bayesian), then export CSV / JSON / Report.',
];

const EXCEL_STEPS = [
  'Switch the mode toggle to "Import results (Excel)".',
  'Prepare a CSV/TSV — one row per (case, model) with a dice column (optionally iou, hd95, assd). Use "Download template" for the exact headers.',
  'Import the file. Each row becomes a record; no model runs on this device and nothing is uploaded.',
  'The Comparison table and Statistical comparison panel now include your imported models — pick Model A / B and run a significance test.',
];

function Track({ title, steps }: { title: string; steps: string[] }) {
  return (
    <div className="space-y-1">
      <div className="font-medium text-tamias-ink dark:text-slate-100">{title}</div>
      <ol className="ml-4 list-decimal space-y-1 text-slate-600 dark:text-slate-300">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </div>
  );
}

export function BenchmarkGuide() {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded border border-slate-200 dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left font-semibold text-tamias-ink dark:text-slate-100"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <HelpCircle className="h-3 w-3 text-tamias-accent" /> How to benchmark — step by step
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3 text-[11px]">
          <Track title="Track A — run models on images" steps={IMAGE_STEPS} />
          <Track title="Track B — import already-computed results (Excel)" steps={EXCEL_STEPS} />
          <div className="text-slate-400">
            No sign-up needed: a local “Local” profile is created automatically. Everything stays on
            this device. Switch to a named profile (👤) only if several people share the machine.
          </div>
        </div>
      )}
    </section>
  );
}
