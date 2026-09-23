/**
 * Registry of the figures mounted in a report, so the report can export them
 * all at once, plus the standalone-SVG renderer (light publication theme).
 */
import { createContext, createElement, useContext, useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { LIGHT, type FigTheme } from './fig-theme';
import { standaloneSvg } from '../../lib/ui/figure-export';

export interface FigureEntry {
  /** File base name (unique within the report). */
  name: string;
  svg?: () => Promise<string>;
  png: () => Promise<Uint8Array>;
}

/** Ordered registry (first-mount order ≈ document order). */
export class FigureRegistry {
  private entries = new Map<string, FigureEntry>();
  private seq = new Map<string, number>();
  private counter = 0;
  add(e: FigureEntry): () => void {
    this.entries.set(e.name, e);
    if (!this.seq.has(e.name)) this.seq.set(e.name, this.counter++);
    return () => {
      if (this.entries.get(e.name) === e) this.entries.delete(e.name);
    };
  }
  list(): FigureEntry[] {
    return [...this.entries.values()].sort((a, b) => (this.seq.get(a.name) ?? 0) - (this.seq.get(b.name) ?? 0));
  }
}

const RegistryCtx = createContext<FigureRegistry | null>(null);

export function FigureRegistryProvider({ registry, children }: { registry: FigureRegistry; children: ReactNode }) {
  return createElement(RegistryCtx.Provider, { value: registry }, children);
}

/** Register an export entry for as long as the calling component is mounted (no-op outside a provider). */
export function useRegisterFigure(entry: FigureEntry | null): void {
  const reg = useContext(RegistryCtx);
  const ref = useRef(entry);
  ref.current = entry;
  const name = entry?.name;
  const hasSvg = !!entry?.svg;
  useEffect(() => {
    if (!reg || !name) return;
    return reg.add({
      name,
      svg: hasSvg ? () => ref.current!.svg!() : undefined,
      png: () => ref.current!.png(),
    });
  }, [reg, name, hasSvg]);
}

/** Standalone light-theme SVG markup of a figure render function. */
export async function renderFigureSvg(render: (t: FigTheme) => ReactElement): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  return standaloneSvg(renderToStaticMarkup(render(LIGHT)));
}
