/**
 * Sensitivity re-scoring of saved benchmark masks (no re-inference).
 *
 *   npx vite-node scripts/bench/rescore.ts -- --records records.ndjson --masks <dir of <model>__<case>.nii.gz> \
 *     --models <dir of <model>.json manifests> --data <dir with <source>/<case>/gt_*.nii.gz> --out <dir>
 *
 * Writes NDJSON files with the same records but re-computed metrics (NSD, lesion detection and mL volumes
 * included); post-processed variants carry `postprocess` so the report keeps them as separate datasets:
 *   records_lcc.ndjson       prediction reduced to its largest 3-D connected component (whole liver)
 *   records_fov.ndjson       predictions zeroed outside the scanner field of view (input CT HU ≤ −1500)
 *   records_fov_lcc.ndjson   FOV mask, then largest component
 *   records_gt_filled.ndjson reference whole liver with enclosed holes (e.g. vessels) filled per axial slice
 * Feed each to scripts/bench/analyze.ts (or the app's "Import records") for the same tables/statistics.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { niftiDataToMask, parseNiftiHeader } from '../../src/lib/datasets/nifti-mask';
import { niftiDataToVolume } from '../../src/lib/datasets/nifti-volume';
import { groupsForModelLabels, scoreLiverTumourCase } from '../../src/lib/metrics/label-groups';
import { applyPostprocess, fillHoles2D, type PostprocessOp } from '../../src/lib/metrics/postprocess';
import { parseMaskFileName } from '../../src/lib/benchmark/mask-compare';
import type { BenchmarkRecord } from '../../src/lib/benchmark/types';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const recordsPath = arg('records')!;
const masksDir = arg('masks')!;
const modelsDir = arg('models')!;
const dataDir = arg('data')!;
const out = arg('out')!;
if (!recordsPath || !masksDir || !modelsDir || !dataDir || !out) throw new Error('need --records --masks --models --data --out');
mkdirSync(out, { recursive: true });

const readGz = (p: string) => {
  const b = readFileSync(p);
  return b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b;
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const records: BenchmarkRecord[] = readFileSync(recordsPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as BenchmarkRecord);
// Latest record per (model sha, case).
const byKey = new Map(records.filter((r) => r.task === 'segmentation').map((r) => [`${r.model.sha256}|${r.case.caseId}`, r]));

const manifests = new Map<string, { labels: Record<number, string>; sha: string }>();
for (const f of readdirSync(modelsDir).filter((f) => f.endsWith('.json') && !f.startsWith('zenodo'))) {
  const id = f.replace(/\.json$/, '');
  const onnx = join(modelsDir, `${id}.onnx`);
  if (!existsSync(onnx)) continue;
  const m = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')) as { output: { labels: Record<number, string> }; sha256?: string };
  manifests.set(id, { labels: m.output.labels, sha: m.sha256 ?? sha(readFileSync(onnx)) });
}

const VARIANTS: Record<string, PostprocessOp[]> = { lcc: ['lcc'], fov: ['fov'], fov_lcc: ['fov', 'lcc'] };
const variants: Record<string, BenchmarkRecord[]> = { lcc: [], fov: [], fov_lcc: [] };
const filled: BenchmarkRecord[] = [];
for (const f of readdirSync(masksDir).sort()) {
  const p = parseMaskFileName(f);
  const man = p && manifests.get(p.modelId);
  if (!p || !man) continue;
  const rec = byKey.get(`${man.sha}|${p.caseId}`);
  if (!rec) {
    console.warn(`no record for ${f}`);
    continue;
  }
  const src = rec.case.imageName.split('/')[0]!;
  const dir = join(dataDir, src, p.caseId);
  const liverRaw = readGz(join(dir, 'gt_liver.nii.gz'));
  const tumourRaw = readGz(join(dir, 'gt_tumor.nii.gz'));
  const liver = niftiDataToMask(liverRaw, parseNiftiHeader(liverRaw));
  const tumour = niftiDataToMask(tumourRaw, parseNiftiHeader(tumourRaw));
  const ct = niftiDataToVolume(readGz(join(dir, 'ct.nii.gz')));
  const ref = new Uint8Array(liver.length);
  for (let i = 0; i < ref.length; i++) ref[i] = tumour[i] ? 2 : liver[i] ? 1 : 0;
  const predRaw = readGz(join(masksDir, f));
  const pred = niftiDataToMask(predRaw, parseNiftiHeader(predRaw));
  const groups = groupsForModelLabels(man.labels);

  // (a) Post-processed predictions (model label space kept; whole-liver members define the LCC).
  const score = (r: Uint8Array, p: Uint8Array) => scoreLiverTumourCase(r, p, ct.dims, ct.spacing, groups);
  for (const [name, ops] of Object.entries(VARIANTS)) {
    const s = score(ref, applyPostprocess(pred, ct.voxels, ct.dims, groups[0]!.predMembers, ops));
    variants[name]!.push({ ...rec, id: `${rec.id}-${name}`, postprocess: [...ops], segmentation: s.segmentation, lesions: s.lesions });
  }

  // (b) Reference whole liver with enclosed holes filled per slice (tumour unchanged).
  const fill = fillHoles2D(ref, ct.dims);
  const refFilled = new Uint8Array(ref.length);
  for (let i = 0; i < ref.length; i++) refFilled[i] = ref[i] === 2 ? 2 : fill[i] ? 1 : 0;
  const sf = score(refFilled, pred);
  filled.push({ ...rec, id: `${rec.id}-gtfilled`, segmentation: sf.segmentation, lesions: sf.lesions });
  const d = (xs: BenchmarkRecord[]) => xs.at(-1)!.segmentation![0]!;
  console.log(
    `${p.modelId}\t${p.caseId}\tdice ${rec.segmentation![0]!.dice.toFixed(3)} → lcc ${d(variants.lcc!).dice.toFixed(3)} / fov ${d(variants.fov!).dice.toFixed(3)} / gtFilled ${d(filled).dice.toFixed(3)}\t` +
      `hd95 ${rec.segmentation![0]!.hd95Mm.toFixed(1)} → lcc ${d(variants.lcc!).hd95Mm.toFixed(1)} / fov ${d(variants.fov!).hd95Mm.toFixed(1)}`
  );
}
const dump = (name: string, rs: BenchmarkRecord[]) => writeFileSync(join(out, name), rs.map((r) => JSON.stringify(r)).join('\n') + '\n');
for (const [name, rs] of Object.entries(variants)) dump(`records_${name}.ndjson`, rs);
dump('records_gt_filled.ndjson', filled);
console.log(`rescored ${filled.length} masks → ${out}`);
