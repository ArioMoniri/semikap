import { useCallback } from 'react';
import { Download, ShieldAlert } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { writeNifti1Uint8 } from '../lib/export/nifti';
import { saveBytes } from '../lib/fs/filesystem';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';

export function ExportPanel() {
  const result = useAppStore((s) => s.result);
  const volume = useAppStore((s) => s.volume);
  const model = useAppStore((s) => s.model);
  const pushError = useAppStore((s) => s.pushError);

  const handleExport = useCallback(async () => {
    if (!result) return;
    try {
      const bytes = writeNifti1Uint8({
        mask: result.mask,
        dims: result.dims,
        spacing: result.spacing,
        origin: result.origin,
      });
      const baseName =
        volume?.source.name.replace(/\.(nii\.gz|nii|nrrd|nhdr|mha|mhd|mgz|mgh|dcm|dicom)$/i, '') ??
        'tamias';
      const modelTag = model?.manifest.name.replace(/[^A-Za-z0-9._-]+/g, '_') ?? 'model';
      const suggested = `${baseName}__${modelTag}__mask.nii`;
      await saveBytes(bytes, suggested, 'NIfTI label mask', '.nii');
    } catch (e) {
      pushError(`Export failed: ${(e as Error).message}`);
    }
  }, [result, volume, model, pushError]);

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
  const voxToMl = result.spacing[0] * result.spacing[1] * result.spacing[2] / 1000;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>Result</CardTitle>
          <CardDescription>
            Inference completed in {(result.elapsedMs / 1000).toFixed(1)}s
          </CardDescription>
        </div>
        <Button size="sm" onClick={handleExport} className="gap-1.5">
          <Download className="h-3.5 w-3.5" /> Save .nii
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <table className="w-full text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-0.5 text-left font-normal">Label</th>
              <th className="py-0.5 text-right font-normal">Voxels</th>
              <th className="py-0.5 text-right font-normal">Volume</th>
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
                  </tr>
                );
              })}
          </tbody>
        </table>
        <Badge variant="warn" className="gap-1">
          <ShieldAlert className="h-3 w-3" /> Research Use Only — not for clinical decision-making.
        </Badge>
      </CardContent>
    </Card>
  );
}
