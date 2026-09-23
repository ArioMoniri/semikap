/**
 * Mask comparison grid — every model's whole-liver prediction on the same
 * key slice of a case, CT in a soft-tissue window, ground truth as an orange
 * outline, prediction as a blue fill, radiological orientation. Fed by the
 * catalogue batch runner, or by importing prediction masks named
 * `<model>__<case>.nii.gz` (e.g. from the headless runner / CI release) for
 * the case currently loaded from the catalogue.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Grid3x3, Upload, AlertTriangle } from 'lucide-react';
import type { BenchmarkRecord } from '../lib/benchmark/types';
import { failureRows, shortModelName, datasetLabel } from '../lib/benchmark/figures';
import { baseDatasetId } from '../lib/benchmark/compare';
import { canvasPng, figSlug } from '../lib/ui/figure-export';
import { downloadBlob } from '../lib/ui/download';
import { ExportButton } from './plots/FigureCard';
import { useRegisterFigure } from './plots/figure-registry';
import { composeGridCanvas, type GridTile } from '../lib/ui/mask-grid';
import { useCatalogStore } from '../lib/state/catalogStore';
import { useBenchmarkStore } from '../lib/state/benchmarkStore';
import { useAppStore } from '../lib/state/store';
import {
  buildKeySlice,
  composeTile,
  parseMaskFileName,
  toRadiological,
  toRadiologicalCt,
  type KeySlice,
} from '../lib/benchmark/mask-compare';
import { groupsForModelLabels } from '../lib/metrics/label-groups';
import { readNiftiVolume } from '../lib/datasets/nifti-volume';
import { canonicalDatasetId } from '../lib/benchmark/compare';
import { Button } from './ui/Button';

const shortName = shortModelName;

const GRID_FOOTER =
  'CT W400/L40, radiological orientation (patient right on image left). Orange = reference whole liver; yellow = reference tumour; blue fill = predicted liver.';

function Tile({
  ks,
  pred,
  title,
  subtitle,
  size,
  highlight = false,
  onCanvas,
}: {
  ks: KeySlice;
  pred: Uint8Array | null;
  title: string;
  subtitle?: string;
  size: number;
  highlight?: boolean;
  onCanvas?(c: HTMLCanvasElement | null): void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = ks.width;
    c.height = ks.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // Outline thick enough to survive the downscale to `size` CSS px.
    const outline = Math.max(1, Math.round(ks.width / size));
    const px = composeTile(ks.ct, ks.gt, pred, ks.width, ks.height, undefined, outline);
    ctx.putImageData(new ImageData(px, ks.width, ks.height), 0, 0);
  }, [ks, pred, size]);
  useEffect(() => {
    onCanvas?.(ref.current);
    return () => onCanvas?.(null);
  }, [onCanvas]);
  async function exportTile() {
    if (!ref.current) return;
    const c = composeGridCanvas([{ canvas: ref.current, title, subtitle }], { cols: 1, header: `${ks.caseKey} · axial slice ${ks.z}`, minTile: 900 });
    downloadBlob(`fig08_tile_${figSlug(ks.caseKey)}_${figSlug(title)}.png`, (await canvasPng(c)) as Uint8Array<ArrayBuffer>, 'image/png');
  }
  return (
    <figure className={`group relative flex flex-col items-center gap-1 rounded p-0.5 ${highlight ? 'ring-2 ring-amber-500' : ''}`} data-testid={`mask-tile-${title}`}>
      <figcaption className="text-center text-[11px] leading-tight text-slate-700 dark:text-slate-200">
        <div className="font-medium">{title}</div>
        {subtitle && <div className="tabular-nums text-slate-500">{subtitle}</div>}
      </figcaption>
      <canvas
        ref={ref}
        style={{ width: size, height: (size * ks.height) / ks.width, imageRendering: 'pixelated' }}
        className="rounded bg-black"
        aria-label={`${title} ${subtitle ?? ''}`}
      />
      <div className="absolute bottom-1 right-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <ExportButton label="PNG" onClick={exportTile} />
      </div>
    </figure>
  );
}

/** Model × case records failing the thresholds; clicking one opens that case in the grid (when its key slice exists). */
function FailuresView({ records, keys, onPick }: { records: BenchmarkRecord[]; keys: string[]; onPick(caseKey: string, model: string): void }) {
  const [dice, setDice] = useState(0.9);
  const [hd, setHd] = useState(50);
  const rows = useMemo(() => failureRows(records, { diceBelow: dice, hd95Above: hd }), [records, dice, hd]);
  const num = 'w-14 rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900';
  return (
    <div className="space-y-1.5" data-testid="mask-failures">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
        <span className="font-medium">Failures</span>
        <label className="flex items-center gap-1">
          whole-liver Dice &lt;
          <input aria-label="Dice threshold" type="number" step={0.01} min={0} max={1} value={dice} className={num} onChange={(e) => setDice(Number(e.currentTarget.value))} />
        </label>
        <label className="flex items-center gap-1">
          or HD95 &gt;
          <input aria-label="HD95 threshold" type="number" step={5} min={0} value={hd} className={num} onChange={(e) => setHd(Number(e.currentTarget.value))} />
          mm
        </label>
        <span className="text-slate-400">{rows.length} model × case</span>
      </div>
      {rows.length > 0 && (
        <div className="max-h-56 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-white text-slate-500 dark:bg-slate-950">
              <tr className="text-left">
                <th className="px-2 py-1">Dataset</th>
                <th className="px-2 py-1">Case</th>
                <th className="px-2 py-1">Model</th>
                <th className="px-2 py-1">Dice</th>
                <th className="px-2 py-1">HD95 (mm)</th>
                <th className="px-2 py-1">Why</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody className="text-slate-700 dark:text-slate-200">
              {rows.map((r) => {
                const ck = `${baseDatasetId(r.dataset)}/${r.caseId}`;
                const has = keys.includes(ck);
                return (
                  <tr key={r.dataset + r.caseId + r.model} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-0.5">{datasetLabel(r.dataset)}</td>
                    <td className="px-2 py-0.5">{r.caseId}</td>
                    <td className="px-2 py-0.5">{shortName(r.model)}</td>
                    <td className="px-2 py-0.5 tabular-nums">{Number.isFinite(r.dice) ? r.dice.toFixed(3) : '—'}</td>
                    <td className="px-2 py-0.5 tabular-nums">{Number.isFinite(r.hd95) ? r.hd95.toFixed(1) : '—'}</td>
                    <td className="px-2 py-0.5 text-slate-500">{r.reasons.join(', ')}</td>
                    <td className="px-2 py-0.5">
                      <button
                        type="button"
                        disabled={!has}
                        onClick={() => onPick(ck, r.model)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-tamias-accent hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
                        title={has ? 'Show this case in the mask grid' : 'No key slice for this case — run it in Catalogue → Batch or import its masks'}
                      >
                        {has ? 'show' : 'no slice'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MaskCompareGrid({ size = 170, records: recordsProp }: { size?: number; records?: BenchmarkRecord[] }) {
  const keySlices = useCatalogStore((s) => s.keySlices);
  const putKeySlice = useCatalogStore((s) => s.putKeySlice);
  const models = useCatalogStore((s) => s.models);
  const storeRecords = useBenchmarkStore((s) => s.records);
  const records = recordsProp ?? storeRecords;
  const [highlight, setHighlight] = useState<string | null>(null);
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const canvasSetters = useRef(new Map<string, (c: HTMLCanvasElement | null) => void>());
  const setterFor = (key: string) => {
    let f = canvasSetters.current.get(key);
    if (!f) {
      f = (c) => {
        if (c) canvases.current.set(key, c);
        else canvases.current.delete(key);
      };
      canvasSetters.current.set(key, f);
    }
    return f;
  };
  const reference = useBenchmarkStore((s) => s.reference);
  const volume = useAppStore((s) => s.volume);
  const keys = Object.keys(keySlices).sort();
  const [caseKey, setCaseKey] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ks = keySlices[caseKey] ?? keySlices[keys[0] ?? ''];
  const sortedPreds = ks ? [...ks.preds].sort((a, b) => a.model.localeCompare(b.model)) : [];

  // Volumetric whole-liver Dice per (dataset/case, model name) from the records.
  const volDice = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      const d = r.segmentation?.find((s) => s.label === 1)?.dice;
      if (typeof d === 'number') m.set(`${canonicalDatasetId(r.datasetName)}/${r.case.caseId}|${r.model.name}`, d);
    }
    return m;
  }, [records]);

  /** Volumetric whole-liver Dice of this model on the loaded case, from the records (catalogue id or ONNX sha256). */
  function recordDice(model: { id: string; sha256?: string }): number | undefined {
    const cat = reference?.catalog;
    if (!cat) return undefined;
    const r = [...records]
      .reverse()
      .find(
        (x) =>
          canonicalDatasetId(x.datasetName) === canonicalDatasetId(cat.datasetId) &&
          x.case.caseId === cat.caseId &&
          (x.model.catalogId === model.id || (!!model.sha256 && x.model.sha256 === model.sha256))
      );
    const d = r?.segmentation?.find((s) => s.label === 1)?.dice;
    return typeof d === 'number' ? d : undefined;
  }

  async function onImport(files: File[]) {
    setMsg(null);
    if (!files.length) return;
    const cat = reference?.catalog;
    if (!cat || !volume || !reference) {
      setMsg('Load a catalogue case (Load CT + GT) first — imported masks are matched to it by case id.');
      return;
    }
    const caseKey = `${cat.datasetId}/${cat.caseId}`;
    const affine = { srowX: volume.meta.srowX, srowY: volume.meta.srowY, srowZ: volume.meta.srowZ };
    const ct = toRadiologicalCt(volume.voxels, volume.meta.dims, affine);
    const gt = toRadiological(reference.mask, reference.dims, affine);
    let added = 0;
    const skipped: string[] = [];
    for (const f of files) {
      const parsed = parseMaskFileName(f.name);
      if (!parsed || parsed.caseId !== cat.caseId) {
        skipped.push(f.name);
        continue;
      }
      const model = models.find((m) => m.id === parsed.modelId);
      const labels = model?.labels;
      if (!model || !labels) {
        skipped.push(`${f.name} (unknown model)`);
        continue;
      }
      const vol = await readNiftiVolume(new Uint8Array(await f.arrayBuffer()), f.name);
      const mask = Uint8Array.from(vol.voxels as ArrayLike<number>);
      const pr = toRadiological(mask, vol.dims, { srowX: vol.srowX, srowY: vol.srowY, srowZ: vol.srowZ });
      if (pr.dims.join() !== gt.dims.join()) {
        skipped.push(`${f.name} (grid ${pr.dims.join('×')} ≠ ${gt.dims.join('×')})`);
        continue;
      }
      const liverLabels = groupsForModelLabels(labels)[0]!.predMembers;
      const built = buildKeySlice({
        caseKey,
        ct: ct.data,
        reference: gt.data,
        dims: gt.dims,
        predictions: [{ model: model.name, mask: pr.data, liverLabels, dice: recordDice(model) }],
      });
      const { preds, ...base } = built;
      putKeySlice(base, preds[0]);
      added++;
    }
    setCaseKey(caseKey);
    setMsg(`Added ${added} mask(s) to ${caseKey}${skipped.length ? ` · skipped: ${skipped.join(', ')}` : ''}.`);
  }

  function tileSubtitle(p: { model: string; dice?: number; sliceDice: number }): string {
    const vd = ks ? (volDice.get(`${ks.caseKey}|${p.model}`) ?? p.dice) : p.dice;
    return `${vd !== undefined ? `Dice ${vd.toFixed(3)} · ` : ''}slice ${p.sliceDice.toFixed(3)}`;
  }
  function gridTiles(): GridTile[] {
    if (!ks) return [];
    const gt = canvases.current.get('__gt__');
    const tiles: GridTile[] = gt ? [{ canvas: gt, title: 'Ground truth' }] : [];
    for (const p of sortedPreds) {
      const c = canvases.current.get(p.model);
      if (c) tiles.push({ canvas: c, title: shortName(p.model), subtitle: tileSubtitle(p) });
    }
    return tiles;
  }
  async function gridPng(): Promise<Uint8Array> {
    const tiles = gridTiles();
    if (!tiles.length || !ks) throw new Error('mask grid is empty');
    return canvasPng(
      composeGridCanvas(tiles, { cols: 5, header: `${ks.caseKey} · axial slice ${ks.z} (most reference liver)`, footer: GRID_FOOTER, minTile: 480 })
    );
  }
  useRegisterFigure(ks ? { name: figSlug(`fig08_mask_grid_${ks.caseKey}`), png: gridPng } : null);
  const failures = recordsProp ? (
    <FailuresView
      records={records}
      keys={keys}
      onPick={(ck, model) => {
        setCaseKey(ck);
        setHighlight(model);
      }}
    />
  ) : null;

  return (
    <section className="space-y-2" data-testid="mask-compare">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-100">
          <Grid3x3 className="h-3.5 w-3.5" /> Mask comparison — all models, same slice
        </span>
        <div className="flex items-center gap-1.5">
          {keys.length > 0 && (
            <select
              aria-label="Mask comparison case"
              value={ks?.caseKey ?? ''}
              onChange={(e) => setCaseKey(e.currentTarget.value)}
              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900"
            >
              {keys.map((k) => (
                <option key={k} value={k}>
                  {k} ({keySlices[k]!.preds.length} models)
                </option>
              ))}
            </select>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".nii,.gz"
            className="hidden"
            data-testid="mask-import-input"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = ''; // re-picking the same file fires onChange again
              void onImport(files);
            }}
          />
          <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => fileRef.current?.click()}>
            <Upload className="h-3 w-3" /> Import masks
          </Button>
          {ks && (
            <ExportButton
              label="Grid PNG"
              testId="mask-grid-export-png"
              onClick={async () => downloadBlob(`${figSlug(`fig08_mask_grid_${ks.caseKey}`)}.png`, (await gridPng()) as Uint8Array<ArrayBuffer>, 'image/png')}
            />
          )}
        </div>
      </div>
      {msg && <p className="text-[11px] text-slate-600 dark:text-slate-300">{msg}</p>}
      {failures}
      {!ks ? (
        <p className="text-[11px] text-slate-500">
          Run a batch benchmark (Catalogue → Batch) or import prediction masks named <code>&lt;model&gt;__&lt;case&gt;.nii.gz</code> for the loaded
          catalogue case.
        </p>
      ) : (
        <>
          <p className="text-[10px] text-slate-500">
            {ks.caseKey} · axial slice {ks.z} (most ground-truth liver) · radiological view (patient right on image left) · orange = ground-truth
            whole-liver outline, yellow = ground-truth tumour outline, blue = prediction (whole liver)
          </p>
          <div className="flex flex-wrap gap-3">
            <Tile ks={ks} pred={null} title="Ground truth" size={size} onCanvas={setterFor('__gt__')} />
            {sortedPreds.map((p) => (
              <Tile
                key={p.model}
                ks={ks}
                pred={p.mask}
                title={shortName(p.model)}
                subtitle={tileSubtitle(p)}
                size={size}
                highlight={highlight !== null && shortName(highlight) === shortName(p.model)}
                onCanvas={setterFor(p.model)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
