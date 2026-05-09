import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  FileJson,
  ShieldAlert,
  Image as ImageIcon,
  Brush,
  FileBox,
  Palette,
} from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { writeNifti1Uint8 } from '../lib/export/nifti';
import { buildReproducibilityBundle, bundleToBytes } from '../lib/export/repro';
import { writeDicomSeg } from '../lib/export/dicom-seg';
import { saveBytes } from '../lib/fs/filesystem';
import { appendAudit } from '../lib/fs/audit';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import type { ViewerHandle } from './Viewer';

// Hoisted module-scope constant so the per-colour brush export's
// useCallback can list it as stable (the lint rule was flagging the
// previous in-component definition as a missing dep on every render).
const BRUSH_COLOUR_NAMES: Record<number, string> = {
  1: 'red',
  2: 'green',
  3: 'blue',
  4: 'yellow',
  5: 'cyan',
  6: 'magenta',
};

const KNOWN_EXT = /\.(nii\.gz|nii|nrrd|nhdr|mha|mhd|mgz|mgh|dcm|dicom)$/i;

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

export function ExportPanel({ viewerRef }: Props) {
  const result = useAppStore((s) => s.result);
  const volume = useAppStore((s) => s.volume);
  const model = useAppStore((s) => s.model);
  const runMeta = useAppStore((s) => s.runMeta);
  const pushError = useAppStore((s) => s.pushError);

  const [busy, setBusy] = useState<string | null>(null);

  const baseName = useMemo(() => {
    const v = volume?.source.name ?? 'tamias';
    return v.replace(KNOWN_EXT, '');
  }, [volume]);
  const modelTag = useMemo(() => {
    return model?.manifest.name.replace(/[^A-Za-z0-9._-]+/g, '_') ?? 'model';
  }, [model]);

  const handleExportMask = useCallback(async () => {
    if (!result) return;
    setBusy('mask');
    try {
      const bytes = writeNifti1Uint8({
        mask: result.mask,
        dims: result.dims,
        spacing: result.spacing,
        origin: result.origin,
      });
      const suggested = `${baseName}__${modelTag}__mask.nii`;
      const ok = await saveBytes(bytes, suggested, 'NIfTI label mask', '.nii');
      if (ok) {
        await appendAudit({
          kind: 'export',
          message: `Exported mask ${suggested} (${result.dims.join('×')}, ${
            (bytes.byteLength / 1024).toFixed(1)
          } KB)`,
          details: {
            model: model?.manifest.name,
            modelHash: model?.hash,
            dims: result.dims,
            spacing: result.spacing,
          },
        });
      }
    } catch (e) {
      pushError(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [result, baseName, modelTag, model, pushError]);

  const handleExportCorrected = useCallback(async () => {
    if (!result) return;
    const corrected = viewerRef.current?.getCorrectedMask(result.mask);
    if (!corrected) {
      pushError('No brush corrections to save (draw on the mask first).');
      return;
    }
    setBusy('corrected');
    try {
      const bytes = writeNifti1Uint8({
        mask: corrected,
        dims: result.dims,
        spacing: result.spacing,
        origin: result.origin,
      });
      const suggested = `${baseName}__${modelTag}__mask_corrected.nii`;
      const ok = await saveBytes(bytes, suggested, 'NIfTI corrected label mask', '.nii');
      if (ok) {
        await appendAudit({
          kind: 'export',
          message: `Exported corrected mask ${suggested}`,
          details: { model: model?.manifest.name, modelHash: model?.hash, dims: result.dims },
        });
      }
    } catch (e) {
      pushError(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [result, viewerRef, baseName, modelTag, model, pushError]);

  /**
   * Save one NIfTI per non-empty brush colour. The user can pick e.g. "Red"
   * and "Blue" while painting; this exports `..__brush_red.nii` and
   * `..__brush_blue.nii` separately so each colour can be used as its own
   * mask in downstream tools (training labels, ITK-SNAP overlays, etc).
   * Names match the v0.5.4 brush palette.
   */
  const handleExportBrushPerColour = useCallback(async () => {
    if (!result) return;
    const drawn = viewerRef.current?.getDrawnLayer();
    if (!drawn) {
      pushError('No brush strokes to save (paint on the mask first).');
      return;
    }
    setBusy('brushColours');
    try {
      // Find which labels were used.
      const labelsPresent = new Set<number>();
      for (let i = 0; i < drawn.length; i++) {
        const v = drawn[i]!;
        if (v !== 0) labelsPresent.add(v);
      }
      if (labelsPresent.size === 0) {
        pushError('Brush layer is empty.');
        return;
      }
      let savedCount = 0;
      for (const lbl of labelsPresent) {
        // Per-colour binary mask — 1 where this label was painted, 0 elsewhere.
        const layer = new Uint8Array(drawn.length);
        for (let i = 0; i < drawn.length; i++) {
          if (drawn[i] === lbl) layer[i] = 1;
        }
        const colourName = BRUSH_COLOUR_NAMES[lbl] ?? `label${lbl}`;
        const bytes = writeNifti1Uint8({
          mask: layer,
          dims: result.dims,
          spacing: result.spacing,
          origin: result.origin,
        });
        const suggested = `${baseName}__${modelTag}__brush_${colourName}.nii`;
        const ok = await saveBytes(
          bytes,
          suggested,
          `NIfTI brush mask · ${colourName}`,
          '.nii'
        );
        if (ok) savedCount++;
      }
      if (savedCount > 0) {
        await appendAudit({
          kind: 'export',
          message: `Exported ${savedCount} per-colour brush mask${savedCount === 1 ? '' : 's'}`,
          details: {
            model: model?.manifest.name,
            modelHash: model?.hash,
            colours: [...labelsPresent].map((l) => BRUSH_COLOUR_NAMES[l] ?? `label${l}`),
          },
        });
      }
    } catch (e) {
      pushError(`Per-colour brush export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [result, viewerRef, baseName, modelTag, model, pushError]);

  const handleExportDicomSeg = useCallback(async () => {
    if (!result || !volume || !model) return;
    if (volume.sourceFormat !== 'dicom') {
      pushError('DICOM-SEG export requires a DICOM source.');
      return;
    }
    setBusy('seg');
    try {
      const bytes = writeDicomSeg({
        sourceDicomBytes: volume.source.bytes,
        mask: result.mask,
        dims: result.dims,
        manifest: model.manifest,
        algorithm: { name: `TAMIAS:${model.manifest.name}`, version: model.manifest.version },
      });
      const suggested = `${baseName}__${modelTag}__seg.dcm`;
      const ok = await saveBytes(bytes, suggested, 'DICOM Segmentation', '.dcm');
      if (ok) {
        await appendAudit({
          kind: 'export',
          message: `Exported DICOM-SEG ${suggested}`,
          details: { model: model.manifest.name, modelHash: model.hash, dims: result.dims },
        });
      }
    } catch (e) {
      pushError(`DICOM-SEG export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [result, volume, model, baseName, modelTag, pushError]);

  const handleExportRepro = useCallback(async () => {
    if (!result || !volume || !model) return;
    setBusy('repro');
    try {
      const bundle = await buildReproducibilityBundle({
        inputFileName: volume.source.name,
        inputBytes: volume.source.bytes,
        modelManifest: model.manifest,
        modelBytes: model.bytes,
        result,
        provider: runMeta?.provider ?? 'unknown',
        attempted: runMeta?.attempted ?? [],
        startedAt: runMeta?.startedAt ?? new Date().toISOString(),
        appVersion: __APP_VERSION__,
      });
      const bytes = bundleToBytes(bundle);
      const suggested = `${baseName}__${modelTag}__repro.json`;
      const ok = await saveBytes(bytes, suggested, 'TAMIAS reproducibility bundle', '.json');
      if (ok) {
        await appendAudit({
          kind: 'export',
          message: `Exported reproducibility bundle ${suggested}`,
          details: { model: model.manifest.name, modelHash: model.hash },
        });
      }
    } catch (e) {
      pushError(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [result, volume, model, runMeta, baseName, modelTag, pushError]);

  useEffect(() => {
    if (result) {
      void appendAudit({
        kind: 'inference',
        message: `Inference complete in ${(result.elapsedMs / 1000).toFixed(2)}s`,
        details: {
          model: model?.manifest.name,
          modelHash: model?.hash,
          provider: runMeta?.provider,
          attempted: runMeta?.attempted,
          dims: result.dims,
          labels: Object.keys(result.labelCounts).length,
        },
      });
    }
    // intentionally only on result change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  if (!result) {
    return (
      <Card>
        <CardContent className="pt-4 text-xs text-slate-500">
          Run inference to enable export.
        </CardContent>
      </Card>
    );
  }

  const labels = model?.manifest.output.labels ?? {};
  const colors = model?.manifest.output.colors ?? {};
  const voxToMl = (result.spacing[0] * result.spacing[1] * result.spacing[2]) / 1000;
  const voxToMm2Surface = (result.spacing[0] + result.spacing[1] + result.spacing[2]) / 3;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>Result</CardTitle>
          <CardDescription>
            Inference completed in {(result.elapsedMs / 1000).toFixed(1)}s
            {runMeta ? ` · ${runMeta.provider.toUpperCase()}` : ''}
          </CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Button size="sm" onClick={handleExportMask} disabled={busy !== null} className="gap-1.5">
            <Download className="h-3.5 w-3.5" /> {busy === 'mask' ? 'Saving…' : 'Save .nii'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportCorrected}
            disabled={busy !== null}
            className="gap-1.5"
            title="Export the AI mask merged with your brush corrections."
          >
            <Brush className="h-3.5 w-3.5" /> {busy === 'corrected' ? 'Saving…' : 'Save corrected'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportBrushPerColour}
            disabled={busy !== null}
            className="gap-1.5"
            title="Save one .nii per brush colour you painted (red, green, …)."
          >
            <Palette className="h-3.5 w-3.5" />
            {busy === 'brushColours' ? 'Saving…' : 'Save brush colours'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportDicomSeg}
            disabled={busy !== null || volume?.sourceFormat !== 'dicom'}
            className="gap-1.5"
            title={
              volume?.sourceFormat === 'dicom'
                ? 'Write a DICOM Segmentation referencing the source DICOM.'
                : 'Available only when the source image is a DICOM file.'
            }
          >
            <FileBox className="h-3.5 w-3.5" /> {busy === 'seg' ? 'Saving…' : 'DICOM-SEG'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportRepro}
            disabled={busy !== null}
            className="gap-1.5"
          >
            <FileJson className="h-3.5 w-3.5" /> {busy === 'repro' ? 'Saving…' : 'Repro JSON'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <table className="w-full text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-0.5 text-left font-normal">Label</th>
              <th className="py-0.5 text-right font-normal">Voxels</th>
              <th className="py-0.5 text-right font-normal">Volume</th>
              <th className="py-0.5 text-right font-normal" title="Voxel-perimeter approximation; for indicative comparisons only.">
                Surface≈
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(result.labelCounts)
              .filter(([k]) => k !== '0')
              .map(([k, count]) => {
                const idx = Number(k);
                const name = labels[idx] ?? `class ${idx}`;
                const color = colors[idx] ?? '#22c55e';
                const ml = count * voxToMl;
                // Crude surface approximation: cube-root proxy of the voxel
                // count multiplied by mean spacing; explicitly indicative.
                const surfaceMm2 = Math.pow(count, 2 / 3) * 6 * voxToMm2Surface * voxToMm2Surface;
                return (
                  <tr key={k} className="border-t border-slate-100">
                    <td className="flex items-center gap-2 py-0.5">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ background: color }}
                      />
                      {name}
                    </td>
                    <td className="py-0.5 text-right tabular-nums">{count.toLocaleString()}</td>
                    <td className="py-0.5 text-right tabular-nums">{ml.toFixed(2)} mL</td>
                    <td className="py-0.5 text-right tabular-nums">
                      {surfaceMm2.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <ImageIcon className="h-3 w-3" />
          Volumes use the source-grid spacing; surface area is a marching-cubes-free voxel
          approximation, not a true mesh measurement.
        </div>
        <Badge variant="warn" className="gap-1">
          <ShieldAlert className="h-3 w-3" /> Research Use Only — not for clinical decision-making.
        </Badge>
      </CardContent>
    </Card>
  );
}
