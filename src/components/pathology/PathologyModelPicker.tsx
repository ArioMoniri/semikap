import { useCallback, useState } from 'react';
import { Brain, FileCheck2 } from 'lucide-react';
import { pickFile } from '../../lib/fs/filesystem';
import { parsePathologyManifest } from '../../lib/pathology/manifest';
import { sha256Hex } from '../../lib/fs/opfs';
import type { PathologyManifest } from '../../types';
import type { PickedFile } from '../../lib/fs/filesystem';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';

const MODEL_ACCEPT: Record<string, string[]> = {
  'application/octet-stream': ['.onnx', '.ort'],
};
const JSON_ACCEPT: Record<string, string[]> = {
  'application/json': ['.json'],
};

export interface PathologyModelRecord {
  source: PickedFile;
  bytes: Uint8Array;
  hash: string;
  manifest: PathologyManifest;
}

interface Props {
  onLoaded(model: PathologyModelRecord): void;
  current: PathologyModelRecord | null;
}

export function PathologyModelPicker({ onLoaded, current }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<PickedFile | null>(null);

  const handlePickModel = useCallback(async () => {
    setError(null);
    const file = await pickFile(MODEL_ACCEPT);
    if (!file) return;
    setPendingModel(file);
  }, []);

  const handlePickManifest = useCallback(async () => {
    if (!pendingModel) {
      setError('Pick the .onnx file first.');
      return;
    }
    const file = await pickFile(JSON_ACCEPT);
    if (!file) return;
    try {
      const text = new TextDecoder().decode(file.bytes);
      const manifest = parsePathologyManifest(JSON.parse(text));
      const hash = await sha256Hex(pendingModel.bytes);
      onLoaded({ source: pendingModel, bytes: pendingModel.bytes, hash, manifest });
      setPendingModel(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [pendingModel, onLoaded]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-tamias-accent" /> Pathology model
          </CardTitle>
          <CardDescription>ONNX patch model + JSON manifest</CardDescription>
        </div>
        <div className="flex flex-col gap-1">
          <Button size="sm" onClick={handlePickModel}>
            1. Pick .onnx
          </Button>
          <Button
            size="sm"
            variant="ink"
            onClick={handlePickManifest}
            disabled={!pendingModel}
          >
            2. Pick manifest .json
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {pendingModel && !current ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
            <span className="font-medium">{pendingModel.name}</span> — pick the
            sidecar manifest JSON to validate input geometry.
          </div>
        ) : null}
        {current ? (
          <div className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
            <div className="flex items-center gap-2">
              <FileCheck2 className="h-4 w-4 text-emerald-600" />
              <span className="font-medium">{current.manifest.name}</span>
              <Badge variant="ok">v{current.manifest.version}</Badge>
            </div>
            <div className="text-slate-500 dark:text-slate-400">
              {current.manifest.mpp.toFixed(3)} µm/px · patch{' '}
              {current.manifest.patch.join('×')} · stride{' '}
              {current.manifest.stride.join('×')} · {current.manifest.output.type}
            </div>
            <div className="font-mono text-[10px] text-slate-400">
              SHA-256: {current.hash.slice(0, 16)}…
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
