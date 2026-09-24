/**
 * A report figure with one-click SVG / PNG export, and a registry so the
 * report can "Export all figures (.zip)". On screen the figure renders with
 * the app theme (light/dark); exports always re-render it with the light
 * publication theme (white background) via renderToStaticMarkup.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { useFigTheme, type FigTheme } from './fig-theme';
import { renderFigureSvg, useRegisterFigure } from './figure-registry';
import { figSlug, svgToPng } from '../../lib/ui/figure-export';
import { downloadBlob } from '../../lib/ui/download';

export function ExportButton({ label, onClick, testId }: { label: string; onClick(): Promise<void> | void; testId?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex items-center gap-0.5 rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      title={`Download ${label}`}
    >
      <Download className="h-2.5 w-2.5" /> {label}
    </button>
  );
}

export function FigureCard({
  name,
  render,
  caption,
}: {
  /** File base name, e.g. "fig05_cd_hcc-tace-seg_whole_liver_dice". */
  name: string;
  render: (t: FigTheme) => ReactElement;
  caption?: ReactNode;
}) {
  const theme = useFigTheme();
  const file = figSlug(name);
  const svg = () => renderFigureSvg(render);
  const png = async () => svgToPng(await svg());
  useRegisterFigure({ name: file, svg, png });
  return (
    <figure className="space-y-1" data-testid={`figure-${file}`}>
      <div className="flex items-center justify-end gap-1">
        {caption && <figcaption className="mr-auto text-[11px] text-slate-500">{caption}</figcaption>}
        <ExportButton label="SVG" testId={`export-svg-${file}`} onClick={async () => downloadBlob(`${file}.svg`, await svg(), 'image/svg+xml')} />
        <ExportButton
          label="PNG"
          testId={`export-png-${file}`}
          onClick={async () => downloadBlob(`${file}.png`, (await png()) as Uint8Array<ArrayBuffer>, 'image/png')}
        />
      </div>
      <div className="overflow-x-auto">{render(theme)}</div>
    </figure>
  );
}

/** Registers a figure for "Export all figures" without showing it (e.g. the options a picker is not showing). */
export function RegisteredFigure({ name, render }: { name: string; render: (t: FigTheme) => ReactElement }) {
  const svg = () => renderFigureSvg(render);
  useRegisterFigure({ name: figSlug(name), svg, png: async () => svgToPng(await svg()) });
  return null;
}
