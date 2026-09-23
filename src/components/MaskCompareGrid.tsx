/**
 * Mask comparison grid — every model's whole-liver prediction on the same
 * key slice of a case, CT in a soft-tissue window, ground truth as an orange
 * outline, prediction as a blue fill, radiological orientation. Fed by the
 * catalogue batch runner, or by importing prediction masks named
 * `<model>__<case>.nii.gz` (e.g. from the headless runner / CI release) for
 * the case currently loaded from the catalogue.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Grid3x3, Upload } from 'lucide-react';
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
import { Button } from './ui/Button';

function shortName(n: string): string {
  const base = n.replace(/@[^@]*$/, '').replace(/\s*\(.*\)\s*$/, '').replace(/^LightningMedSeg3D /, '');
  return base.startsWith('nnU-Net') ? 'nnU-Net (LiTS)' : base;
}

function Tile({
  ks,
  pred,
  title,
  subtitle,
  size,
}: {
  ks: KeySlice;
  pred: Uint8Array | null;
  title: string;
  subtitle?: string;
  size: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = ks.width;
    c.height = ks.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const px = composeTile(ks.ct, ks.gt, pred, ks.width, ks.height);
    ctx.putImageData(new ImageData(px, ks.width, ks.height), 0, 0);
  }, [ks, pred]);
  return (
    <figure className="flex flex-col items-center gap-1">
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
    </figure>
  );
}

export function MaskCompareGrid({ size = 170 }: { size?: number }) {
  const keySlices = useCatalogStore((s) => s.keySlices);
  const putKeySlice = useCatalogStore((s) => s.putKeySlice);
  const models = useCatalogStore((s) => s.models);
  const records = useBenchmarkStore((s) => s.records);
  const reference = useBenchmarkStore((s) => s.reference);
  const volume = useAppStore((s) => s.volume);
  const keys = Object.keys(keySlices).sort();
  const [caseKey, setCaseKey] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ks = keySlices[caseKey] ?? keySlices[keys[0] ?? ''];

  // Volumetric whole-liver Dice per (dataset/case, model name) from the records.
  const volDice = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      const d = r.segmentation?.find((s) => s.label === 1)?.dice;
      if (typeof d === 'number') m.set(`${r.datasetName}/${r.case.caseId}|${r.model.name}`, d);
    }
    return m;
  }, [records]);

  async function onImport(files: FileList | null) {
    setMsg(null);
    if (!files?.length) return;
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
    for (const f of Array.from(files)) {
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
        predictions: [{ model: model.name, mask: pr.data, liverLabels }],
      });
      const { preds, ...base } = built;
      putKeySlice(base, preds[0]);
      added++;
    }
    setCaseKey(caseKey);
    setMsg(`Added ${added} mask(s) to ${caseKey}${skipped.length ? ` · skipped: ${skipped.join(', ')}` : ''}.`);
  }

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
            onChange={(e) => void onImport(e.currentTarget.files)}
          />
          <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => fileRef.current?.click()}>
            <Upload className="h-3 w-3" /> Import masks
          </Button>
        </div>
      </div>
      {msg && <p className="text-[11px] text-slate-600 dark:text-slate-300">{msg}</p>}
      {!ks ? (
        <p className="text-[11px] text-slate-500">
          Run a batch benchmark (Catalogue → Batch) or import prediction masks named <code>&lt;model&gt;__&lt;case&gt;.nii.gz</code> for the loaded
          catalogue case.
        </p>
      ) : (
        <>
          <p className="text-[10px] text-slate-500">
            {ks.caseKey} · axial slice {ks.z} (most ground-truth liver) · radiological view (patient right on image left) · orange = ground
            truth outline, blue = prediction (whole liver)
          </p>
          <div className="flex flex-wrap gap-3">
            <Tile ks={ks} pred={null} title="Ground truth" size={size} />
            {[...ks.preds]
              .sort((a, b) => a.model.localeCompare(b.model))
              .map((p) => {
                const vd = volDice.get(`${ks.caseKey}|${p.model}`) ?? p.dice;
                return (
                  <Tile
                    key={p.model}
                    ks={ks}
                    pred={p.mask}
                    title={shortName(p.model)}
                    subtitle={`${vd !== undefined ? `Dice ${vd.toFixed(3)} · ` : ''}slice ${p.sliceDice.toFixed(3)}`}
                    size={size}
                  />
                );
              })}
          </div>
        </>
      )}
    </section>
  );
}
