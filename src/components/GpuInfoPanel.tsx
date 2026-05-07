import { Cpu, ShieldCheck, ShieldAlert, Zap } from 'lucide-react';
import type { BackendInfo } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Badge } from './ui/Badge';

interface Props {
  backend: BackendInfo | null;
}

export function GpuInfoPanel({ backend }: Props) {
  if (!backend) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-slate-500">Detecting GPU…</CardContent>
      </Card>
    );
  }

  const isWebGPU = backend.provider === 'webgpu';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          {isWebGPU ? <Zap className="h-4 w-4 text-tamias-accent" /> : <Cpu className="h-4 w-4 text-slate-500" />}
          Inference backend
        </CardTitle>
        <Badge variant={isWebGPU ? 'accent' : 'outline'}>{backend.provider.toUpperCase()}</Badge>
      </CardHeader>
      <CardContent className="space-y-1 text-xs text-slate-600">
        {backend.adapter ? (
          <>
            <Row label="Vendor" value={backend.adapter.vendor || 'unknown'} />
            <Row label="Architecture" value={backend.adapter.architecture || 'unknown'} />
            <Row label="Device" value={backend.adapter.device || 'unknown'} />
            {backend.adapter.description && (
              <div className="text-slate-500">{backend.adapter.description}</div>
            )}
          </>
        ) : (
          <Row label="WASM threads" value={String(backend.wasmThreads ?? 1)} />
        )}
        <div className="flex items-center gap-1.5 pt-1 text-[11px]">
          {backend.crossOriginIsolated ? (
            <>
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              <span className="text-emerald-700">cross-origin isolated · multi-thread WASM available</span>
            </>
          ) : (
            <>
              <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
              <span className="text-amber-700">not isolated · single-threaded WASM only</span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="truncate font-medium text-slate-700">{value}</span>
    </div>
  );
}
