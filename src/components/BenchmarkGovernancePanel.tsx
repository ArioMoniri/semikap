/**
 * Benchmark governance sub-panel (Phase 4): generate a model card for the
 * loaded model, create + lock a versioned benchmark definition from the
 * registry, and compute a reference-set lock (content fingerprint) over the
 * scored cases so a benchmark is reproducible against a fixed reference set.
 */

import { useState } from 'react';
import { FileText, Lock, Fingerprint } from 'lucide-react';
import { buildModelCard, modelCardToMarkdown } from '../lib/registry/model-card';
import { validateOnnx } from '../lib/registry/onnx-validate';
import { lockDefinition, type BenchmarkDefinition } from '../lib/benchmark/definition';
import { computeDatasetLock } from '../lib/datasets/lock';
import type { DatasetManifest, CaseManifest } from '../lib/datasets/manifest';
import type { RegistryEntry } from '../lib/registry/registry';
import type { ModelRecord } from '../lib/state/store';
import type { ReferenceSnapshot } from '../lib/state/benchmarkStore';
import type { BenchmarkRecord } from '../lib/benchmark/types';
import { downloadText } from '../lib/ui/download';
import { Button } from './ui/Button';

interface Props {
  profileId: string | null;
  entries: RegistryEntry[];
  loadedModel: ModelRecord | null;
  reference: ReferenceSnapshot | null;
  records: BenchmarkRecord[];
}

export function BenchmarkGovernancePanel({ profileId, entries, loadedModel, reference, records }: Props) {
  const [notice, setNotice] = useState<string | null>(null);

  if (!profileId) return null;

  function onModelCard() {
    if (!loadedModel) return;
    const card = buildModelCard({
      manifest: loadedModel.manifest,
      validation: validateOnnx(loadedModel.bytes),
      generatedAt: new Date().toISOString(),
    });
    downloadText(
      `model-card-${loadedModel.manifest.name.replace(/\s+/g, '_')}.md`,
      modelCardToMarkdown(card),
      'text/markdown'
    );
    setNotice(`Model card generated for "${loadedModel.manifest.name}".`);
  }

  function onBenchmarkDefinition() {
    const def: BenchmarkDefinition = {
      schema: 'tamias.benchmarkdef.v1',
      id: crypto.randomUUID(),
      name: reference?.label ?? 'benchmark',
      version: '1',
      task: 'segmentation',
      datasetName: reference?.label ?? 'captured-reference',
      modelHashes: entries.map((e) => e.hash),
      metricConfig: { surface: true },
      locked: false,
      createdAt: new Date().toISOString(),
    };
    const locked = lockDefinition(def);
    downloadText('tamias-benchmark-definition.json', JSON.stringify(locked, null, 2), 'application/json');
    setNotice(`Locked benchmark definition with ${locked.modelHashes.length} model(s).`);
  }

  async function onReferenceLock() {
    const seen = new Set<string>();
    const cases: CaseManifest[] = [];
    for (const r of records) {
      if (seen.has(r.case.caseId)) continue;
      seen.add(r.case.caseId);
      cases.push({
        caseId: r.case.caseId,
        imageName: r.case.imageName,
        groundTruthAvailable: !!r.case.referenceName,
        ...(r.case.referenceName ? { referenceLabelName: r.case.referenceName } : {}),
      });
    }
    const ds: DatasetManifest = {
      schema: 'tamias.dataset.v1',
      name: 'scored-cases',
      task: 'segmentation',
      cases,
    };
    const fileHashes: Record<string, string> = {};
    for (const r of records) {
      if (r.case.imageSha256) fileHashes[r.case.imageName] = r.case.imageSha256;
    }
    const lock = await computeDatasetLock(ds, fileHashes, new Date().toISOString());
    downloadText('tamias-reference-lock.json', JSON.stringify(lock, null, 2), 'application/json');
    setNotice(`Reference set locked: ${lock.caseCount} case(s), fingerprint ${lock.fingerprint.slice(0, 12)}…`);
  }

  return (
    <section className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
      <div className="font-semibold text-tamias-ink dark:text-slate-100">Governance</div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onModelCard} disabled={!loadedModel}>
          <FileText className="h-3 w-3" /> Model card
        </Button>
        <Button size="sm" variant="outline" onClick={onBenchmarkDefinition} disabled={entries.length === 0}>
          <Lock className="h-3 w-3" /> Lock definition
        </Button>
        <Button size="sm" variant="outline" onClick={() => void onReferenceLock()} disabled={records.length === 0}>
          <Fingerprint className="h-3 w-3" /> Lock reference set
        </Button>
      </div>
      {notice && <div className="text-emerald-600 dark:text-emerald-400">{notice}</div>}
    </section>
  );
}
