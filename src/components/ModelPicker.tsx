import { useCallback, useState } from 'react';
import { Brain, FileCheck2 } from 'lucide-react';
import { pickFile } from '../lib/fs/filesystem';
import { parseManifest } from '../lib/inference/manifest';
import { sha256Hex } from '../lib/fs/opfs';
import type { ModelManifest } from '../types';
import type { ModelRecord } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';

interface Props {
  onLoaded(model: ModelRecord): void;
  current: ModelRecord | null;
}

export function ModelPicker({ onLoaded, current }: Props) {
  const [error, setError] = useState<string | null>(null);

  const handlePickModel = useCallback(async () => {
    setError(null);
    try {
      const onnx = await pickFile({ 'application/octet-stream': ['.onnx', '.ort'] });
      if (!onnx) return;

      const manifestFile = await pickFile({ 'application/json': ['.json'] });
      if (!manifestFile) {
        setError('A manifest JSON is required (one was not selected).');
        return;
      }

      let manifest: ModelManifest;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(manifestFile.bytes));
        manifest = parseManifest(parsed);
      } catch (e) {
        setError(`Manifest invalid: ${(e as Error).message}`);
        return;
      }

      const hash = await sha256Hex(onnx.bytes);
      if (manifest.sha256 && manifest.sha256.toLowerCase() !== hash.toLowerCase()) {
        setError(
          `Manifest sha256 mismatch:\n  expected ${manifest.sha256}\n  actual   ${hash}`
        );
        return;
      }

      onLoaded({ source: onnx, bytes: onnx.bytes, hash, manifest });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [onLoaded]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-tamias-accent" /> ONNX model + manifest
          </CardTitle>
          <CardDescription>
            Pick an .onnx (or .ort) followed by its manifest .json sidecar.
          </CardDescription>
        </div>
        <Button size="sm" onClick={handlePickModel}>
          Load…
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {current && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="ok" className="gap-1">
                <FileCheck2 className="h-3 w-3" /> {current.manifest.modality}
              </Badge>
              <span className="font-medium text-slate-800">{current.manifest.name}</span>
              <span className="text-slate-400">v{current.manifest.version}</span>
            </div>
            <div className="text-[11px] text-slate-500">
              Spacing [{current.manifest.spacing.join(', ')}] mm · {current.manifest.inference.type.replace('_', ' ')}
            </div>
            <div className="truncate text-[11px] text-slate-400">SHA-256 {current.hash.slice(0, 16)}…</div>
          </div>
        )}
        {error && (
          <pre className="whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">
            {error}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
