import { describe, expect, it, vi } from 'vitest';
import { isPairRecorded, runCatalogBatch, type BatchDeps } from '../src/lib/catalog/batch';

type Vol = { id: string };
type Mdl = { id: string };

function deps(over: Partial<BatchDeps<Vol, Mdl>> = {}) {
  const calls: string[] = [];
  const d: BatchDeps<Vol, Mdl> = {
    loadCase: vi.fn(async (c) => {
      calls.push(`case:${c.caseId}`);
      return { volume: { id: c.caseId }, reference: { mask: new Uint8Array(1), dims: [1, 1, 1], spacing: [1, 1, 1] } };
    }),
    loadModel: vi.fn(async (m) => {
      calls.push(`model:${m.id}`);
      return { id: m.id };
    }),
    infer: vi.fn(async (v, m) => {
      calls.push(`infer:${v.id}:${m.id}`);
      return { mask: new Uint8Array(1), dims: [1, 1, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number], elapsedMs: 5, provider: 'wasm' };
    }),
    score: vi.fn(async () => [{ label: 1, dice: 0.9 } as never]),
    onResult: vi.fn(),
    ...over,
  };
  return { d, calls };
}

const cases = [
  { datasetId: 'hcc-tace-seg', caseId: 'A' },
  { datasetId: 'hcc-tace-seg', caseId: 'B' },
];
const models = [
  { id: 'm1', name: 'M1' },
  { id: 'm2', name: 'M2' },
];

describe('runCatalogBatch', () => {
  it('loads each case once and runs every model on it (case-outer: one case + one model in memory)', async () => {
    const { d, calls } = deps();
    const r = await runCatalogBatch(cases, models, d);
    expect(calls).toEqual([
      'case:A', 'model:m1', 'infer:A:m1', 'model:m2', 'infer:A:m2',
      'case:B', 'model:m1', 'infer:B:m1', 'model:m2', 'infer:B:m2',
    ]);
    expect(r.completed).toBe(4);
    expect(r.failed).toEqual([]);
    expect(d.onResult).toHaveBeenCalledTimes(4);
    const first = (d.onResult as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(first.case.caseId).toBe('A');
    expect(first.model.id).toBe('m1');
    expect(first.metrics[0].dice).toBe(0.9);
  });

  it('isolates failures per (case, model) and per case', async () => {
    const { d } = deps({
      infer: vi.fn(async (v: Vol, m: Mdl) => {
        if (v.id === 'A' && m.id === 'm2') throw new Error('OOM');
        return { mask: new Uint8Array(1), dims: [1, 1, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number], elapsedMs: 1, provider: 'wasm' };
      }),
    });
    (d.loadCase as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('IDC down');
    });
    const r = await runCatalogBatch(cases, models, d);
    // case A failed to load → both its models fail; case B runs both.
    expect(r.completed).toBe(2);
    expect(r.failed.map((f) => `${f.caseId}:${f.modelId ?? '*'}:${f.error}`)).toEqual(['A:*:IDC down']);
  });

  it('records a per-model failure and continues', async () => {
    const { d } = deps({
      infer: vi.fn(async (v: Vol, m: Mdl) => {
        if (m.id === 'm2') throw new Error('OOM');
        return { mask: new Uint8Array(1), dims: [1, 1, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number], elapsedMs: 1, provider: 'wasm' };
      }),
    });
    const r = await runCatalogBatch(cases, models, d);
    expect(r.completed).toBe(2);
    expect(r.failed).toEqual([
      { caseId: 'A', datasetId: 'hcc-tace-seg', modelId: 'm2', error: 'OOM' },
      { caseId: 'B', datasetId: 'hcc-tace-seg', modelId: 'm2', error: 'OOM' },
    ]);
  });

  it('reports progress and stops when cancelled', async () => {
    const signal = { aborted: false };
    const progress: string[] = [];
    const { d } = deps({
      onResult: vi.fn(() => {
        signal.aborted = true; // cancel after the first result
      }),
    });
    const r = await runCatalogBatch(cases, models, { ...d, signal, onProgress: (p) => progress.push(`${p.done}/${p.total} ${p.stage}`) });
    expect(r.completed).toBe(1);
    expect(r.cancelled).toBe(true);
    expect(progress[0]).toBe('0/4 loading case');
  });

  it('skips pairs that already have a record (resume)', async () => {
    const { d, calls } = deps();
    const r = await runCatalogBatch(cases, models, { ...d, isDone: (c, m) => c.caseId === 'A' && m.id === 'm1' });
    expect(calls).not.toContain('infer:A:m1');
    expect(r.completed).toBe(3);
    expect(r.skipped).toBe(1);
  });

  it('does not re-download a model that failed to load; later cases record the error', async () => {
    const { d, calls } = deps({
      loadModel: vi.fn(async (m) => {
        calls.push(`model:${m.id}`);
        if (m.id === 'm1') throw new Error('404');
        return { id: m.id };
      }),
    });
    const r = await runCatalogBatch(cases, models, d);
    expect(calls.filter((c) => c === 'model:m1')).toHaveLength(1);
    expect(r.completed).toBe(2);
    expect(r.failed).toEqual([
      { datasetId: 'hcc-tace-seg', caseId: 'A', modelId: 'm1', error: '404' },
      { datasetId: 'hcc-tace-seg', caseId: 'B', modelId: 'm1', error: 'model failed to load earlier: 404' },
    ]);
  });

  it('treats an error raised after abort as cancellation, not a failure', async () => {
    const signal = { aborted: false };
    const { d } = deps({
      loadModel: vi.fn(async () => {
        signal.aborted = true;
        throw new DOMException('The operation was aborted.', 'AbortError');
      }),
    });
    const r = await runCatalogBatch(cases, models, { ...d, signal });
    expect(r.cancelled).toBe(true);
    expect(r.failed).toEqual([]);
  });

  it('isPairRecorded matches dataset, case and catalogue model id (resume from stored records)', async () => {
    const records = [{ datasetName: 'hcc-tace-seg', case: { caseId: 'A' }, model: { catalogId: 'm1' } }];
    expect(isPairRecorded(records, cases[0]!, models[0]!)).toBe(true);
    expect(isPairRecorded(records, cases[0]!, models[1]!)).toBe(false);
    expect(isPairRecorded(records, cases[1]!, models[0]!)).toBe(false);
    expect(isPairRecorded([{ datasetName: 'hcc-tace-seg', case: { caseId: 'A' }, model: {} }], cases[0]!, models[0]!)).toBe(false);
    const { d, calls } = deps();
    const r = await runCatalogBatch(cases, models, { ...d, isDone: (c, m) => isPairRecorded(records, c, m) });
    expect(calls).not.toContain('infer:A:m1');
    expect(r.skipped).toBe(1);
  });
});
