import { useCallback } from 'react';
import { FileJson, Image as ImageIcon, Palette } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { saveBytes } from '../../lib/fs/filesystem';
import { asBytes } from '../../types';
import type {
  PathologyManifest,
  PathologyRunOutput,
  PickedSlide,
} from '../../types';
import { BRUSH_PALETTE } from '../../lib/pathology/osd-viewer';
import type { PathologyViewerHandle } from './PathologyViewer';

interface Props {
  result: PathologyRunOutput | null;
  manifest: PathologyManifest | null;
  slide: PickedSlide | null;
  viewerRef: React.MutableRefObject<PathologyViewerHandle | null>;
}

export function PathologyExportPanel({ result, manifest, slide, viewerRef }: Props) {
  const handlePng = useCallback(async () => {
    if (!result || !manifest || !slide) return;
    const png = await renderResultPng(result, manifest);
    if (!png) return;
    const arr = new Uint8Array(await png.arrayBuffer());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = slide.name.replace(/\.[^.]+$/, '');
    await saveBytes(asBytes(arr), `${base}__${manifest.name}__${stamp}.png`, 'PNG image', '.png');
  }, [result, manifest, slide]);

  const handleJson = useCallback(async () => {
    if (!result || !manifest || !slide) return;
    const payload = {
      tamias: { version: __APP_VERSION__, kind: 'pathology-result' },
      slide: { name: slide.name, bytes: slide.bytes.length },
      manifest: {
        name: manifest.name,
        version: manifest.version,
        mpp: manifest.mpp,
        patch: manifest.patch,
        stride: manifest.stride,
        outputType: manifest.output.type,
      },
      result: {
        kind: result.kind,
        roi: result.roi,
        mpp: result.mpp,
        width: result.resultWidth,
        height: result.resultHeight,
        provider: result.provider,
        attempted: result.attempted,
        durationMs: Math.round(result.durationMs),
        ...(result.patches ? { patches: result.patches } : {}),
      },
    };
    const text = JSON.stringify(payload, null, 2);
    const arr = new Uint8Array(new TextEncoder().encode(text));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = slide.name.replace(/\.[^.]+$/, '');
    await saveBytes(asBytes(arr), `${base}__${manifest.name}__${stamp}.json`, 'JSON sidecar', '.json');
  }, [result, manifest, slide]);

  const handleBrushPerColour = useCallback(async () => {
    if (!slide) return;
    const brush = viewerRef.current?.getBrushBuffer();
    if (!brush) return;
    const present = new Set<number>();
    for (let i = 0; i < brush.buffer.length; i++) {
      const v = brush.buffer[i];
      if (v && v > 0) present.add(v);
    }
    if (present.size === 0) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = slide.name.replace(/\.[^.]+$/, '');

    for (const label of present) {
      const colour = BRUSH_PALETTE.find((c) => c.label === label);
      if (!colour) continue;
      const png = await renderBrushChannelPng(brush, label, colour.hex);
      if (!png) continue;
      const arr = new Uint8Array(await png.arrayBuffer());
      await saveBytes(
        asBytes(arr),
        `${base}__brush_${colour.name}__${stamp}.png`,
        `Brush layer (${colour.name})`,
        '.png'
      );
    }
  }, [slide, viewerRef]);

  const disabled = !result || !manifest || !slide;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Export</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          disabled={disabled}
          onClick={handlePng}
        >
          <ImageIcon className="h-3.5 w-3.5" /> Save result PNG
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          disabled={disabled}
          onClick={handleJson}
        >
          <FileJson className="h-3.5 w-3.5" /> Save result JSON
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          disabled={!slide}
          onClick={handleBrushPerColour}
          title="Save each painted colour as its own PNG mask"
        >
          <Palette className="h-3.5 w-3.5" /> Save brush colours
        </Button>
        <p className="text-[10px] text-slate-500 dark:text-slate-400">
          Research Use Only — every export is stamped in the JSON sidecar.
        </p>
      </CardContent>
    </Card>
  );
}

async function renderResultPng(
  result: PathologyRunOutput,
  manifest: PathologyManifest
): Promise<Blob | null> {
  // Render the per-pixel buffer to a canvas using the manifest's colour
  // table, identical to the on-screen overlay so the exported PNG matches
  // what the user sees.
  const canvas = document.createElement('canvas');
  canvas.width = result.resultWidth;
  canvas.height = result.resultHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(result.resultWidth, result.resultHeight);

  const colours = (() => {
    if (manifest.output.type === 'segmentation') return manifest.output.colors ?? {};
    if (manifest.output.type === 'classification') return manifest.output.colors ?? {};
    if (manifest.output.type === 'heatmap') return { 1: manifest.output.color ?? '#ff0040' };
    return {};
  })();

  if (result.kind === 'heatmap') {
    const high = parseHex(colours[1] ?? '#ff0040');
    for (let i = 0; i < result.buffer.length; i++) {
      const s = result.buffer[i] as number;
      img.data[i * 4] = high[0];
      img.data[i * 4 + 1] = high[1];
      img.data[i * 4 + 2] = high[2];
      img.data[i * 4 + 3] = s;
    }
  } else {
    for (let i = 0; i < result.buffer.length; i++) {
      const label = result.buffer[i] as number;
      if (label === 0) {
        img.data[i * 4 + 3] = 0;
        continue;
      }
      const c = parseHex(colours[label] ?? '#3b82f6');
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 220;
    }
  }

  ctx.putImageData(img, 0, 0);
  return new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'));
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 0, 64];
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Render a single brush colour channel as a PNG. Pixels matching
 *  `label` are drawn in `hex` at full alpha; everything else is left
 *  transparent. The output dimensions match the brush canvas size
 *  (capped at 4 K), not the slide level-0 size. */
async function renderBrushChannelPng(
  brush: { buffer: Uint8Array; width: number; height: number },
  label: number,
  hex: string
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = brush.width;
  canvas.height = brush.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(brush.width, brush.height);
  const c = parseHex(hex);
  for (let i = 0; i < brush.buffer.length; i++) {
    if (brush.buffer[i] === label) {
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
    } else {
      img.data[i * 4 + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'));
}
