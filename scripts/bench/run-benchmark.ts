/**
 * Headless TAMIAS benchmark runner.
 *
 * Runs catalogue ONNX models over NIfTI cases with TAMIAS's OWN pipeline
 * (reorientation → resample → normalise → sliding window → inverse) and
 * scoring (label groups: whole liver, tumour; Dice/IoU/HD95/ASSD), and writes
 * `tamias.benchmark.v1` records (NDJSON) that the app's Benchmark panel
 * imports for the statistics UI. Only the ORT backend differs from the
 * browser: onnxruntime-node (CPU) instead of onnxruntime-web.
 *
 *   ORT_NODE=/path/to/node_modules/onnxruntime-node \
 *   npx vite-node --config scripts/bench/vite.config.ts scripts/bench/run-benchmark.ts -- \
 *     --data <dir with cases.csv> --models <dir with *.onnx + *.json> --out <dir> [--only id,id] [--cases id,id]
 *
 * cases.csv columns used: source, case_id; files <data>/<source>/<case_id>/{ct,gt_liver,gt_tumor}.nii.gz
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as ort from 'onnxruntime-web'; // aliased to onnxruntime-node by vite.config.ts
import { parseManifest } from '../../src/lib/inference/manifest';
import { preparePreprocessing } from '../../src/lib/inference/preprocess';
import { slidingWindowInference } from '../../src/lib/inference/sliding-window';
import { resampleNearest } from '../../src/lib/inference/postprocess';
import { axisCodes, planReorientation, invertReorientation, isIdentityPlan } from '../../src/lib/inference/orient';
import { niftiDataToVolume } from '../../src/lib/datasets/nifti-volume';
import { niftiDataToMask, parseNiftiHeader } from '../../src/lib/datasets/nifti-mask';
import { scoreLabelGroups, LIVER_TUMOUR_GROUPS } from '../../src/lib/metrics/label-groups';
import type { BenchmarkRecord } from '../../src/lib/benchmark/types';
import type { ModelManifest } from '../../src/types';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const dataDir = arg('data')!;
const modelsDir = arg('models')!;
const outDir = arg('out')!;
const only = arg('only')?.split(',');
const onlyCases = arg('cases')?.split(',');
const threads = Number(arg('threads', '4'));
const saveMasks = arg('save-masks', '1') === '1';
if (!dataDir || !modelsDir || !outDir) throw new Error('need --data --models --out');
mkdirSync(join(outDir, 'masks'), { recursive: true });

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let cur: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      cur.push(f);
      f = '';
    } else if (c === '\n') {
      cur.push(f);
      rows.push(cur);
      cur = [];
      f = '';
    } else if (c !== '\r') f += c;
  }
  if (f || cur.length) {
    cur.push(f);
    rows.push(cur);
  }
  const [h, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(h!.map((k, i) => [k, r[i] ?? ''])));
}

function readGz(p: string): Uint8Array {
  const b = readFileSync(p);
  return b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b;
}

/** uint8 mask NIfTI with the CT's header (same grid/affine). */
function maskNifti(ctRaw: Uint8Array, mask: Uint8Array): Buffer {
  const hdr = Buffer.from(ctRaw.subarray(0, 352));
  hdr.writeInt16LE(2, 70); // datatype uint8
  hdr.writeInt16LE(8, 72); // bitpix
  hdr.writeFloatLE(352, 108); // vox_offset
  hdr.writeFloatLE(0, 112); // scl_slope
  hdr.writeFloatLE(0, 116);
  return gzipSync(Buffer.concat([hdr, Buffer.from(mask)]));
}

const cases = parseCsv(readFileSync(join(dataDir, 'cases.csv'), 'utf8')).filter(
  (c) => !onlyCases || onlyCases.includes(c.case_id!)
);
const models = readdirSync(modelsDir)
  .filter((f) => f.endsWith('.onnx'))
  .map((f) => basename(f, '.onnx'))
  .filter((id) => existsSync(join(modelsDir, `${id}.json`)) && (!only || only.includes(id)));

const ndjson = join(outDir, 'records.ndjson');
const log = (s: string) => {
  console.log(s);
  appendFileSync(join(outDir, 'run.log'), s + '\n');
};
log(`models=${models.join(',')} cases=${cases.length} threads=${threads}`);

for (const id of models) {
  const bytes = new Uint8Array(readFileSync(join(modelsDir, `${id}.onnx`)));
  const manifest: ModelManifest = parseManifest(JSON.parse(readFileSync(join(modelsDir, `${id}.json`), 'utf8')));
  const modelSha = sha(bytes);
  const tl = performance.now();
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['cpu'],
    intraOpNumThreads: threads,
    graphOptimizationLevel: 'all',
  });
  const loadMs = performance.now() - tl;
  for (const c of cases) {
    const dir = join(dataDir, c.source!, c.case_id!);
    const done = existsSync(ndjson)
      ? readFileSync(ndjson, 'utf8').includes(`"caseId":"${c.case_id}"`) &&
        readFileSync(ndjson, 'utf8')
          .split('\n')
          .some((l) => l.includes(`"caseId":"${c.case_id}"`) && l.includes(`"sha256":"${modelSha}"`))
      : false;
    if (done) {
      log(`skip ${id} ${c.case_id} (already recorded)`);
      continue;
    }
    try {
      const t0 = performance.now();
      const ctRaw = readGz(join(dir, 'ct.nii.gz'));
      const vol = niftiDataToVolume(ctRaw);
      const plan =
        vol.srowX && vol.srowY && vol.srowZ
          ? planReorientation(axisCodes(vol.srowX, vol.srowY, vol.srowZ), manifest.orientation)
          : null;
      const pre = preparePreprocessing(vol.voxels, vol.dims, vol.spacing, manifest, plan && !isIdentityPlan(plan) ? plan : null);
      if (manifest.inference.type !== 'sliding_window') throw new Error('runner supports sliding_window models');
      const ti = performance.now();
      const sw = await slidingWindowInference(session as never, pre.data, pre.dims, {
        patch: manifest.inference.patch,
        overlap: manifest.inference.overlap,
      });
      const inferMs = performance.now() - ti;
      const oriented = resampleNearest(sw.mask, sw.dims, pre.orientedDims);
      const pred = plan ? invertReorientation(oriented, pre.orientedDims, plan).data : oriented;

      const liverRaw = readGz(join(dir, 'gt_liver.nii.gz'));
      const tumourRaw = readGz(join(dir, 'gt_tumor.nii.gz'));
      const liver = niftiDataToMask(liverRaw, parseNiftiHeader(liverRaw));
      const tumour = niftiDataToMask(tumourRaw, parseNiftiHeader(tumourRaw));
      const ref = new Uint8Array(liver.length);
      for (let i = 0; i < ref.length; i++) ref[i] = tumour[i] ? 2 : liver[i] ? 1 : 0;
      // Models without a tumour class: tumour group is scored only if the model has label 2.
      const hasTumour = Object.values(manifest.output.labels).some((l) => /tum|lesion|mass/i.test(l));
      const groups = hasTumour ? LIVER_TUMOUR_GROUPS : LIVER_TUMOUR_GROUPS.slice(0, 1);
      const tm = performance.now();
      const seg = scoreLabelGroups(ref, pred, vol.dims, vol.spacing, groups);
      const metricMs = performance.now() - tm;

      const rec: BenchmarkRecord = {
        schema: 'tamias.benchmark.v1',
        id: randomUUID(),
        profileId: 'default',
        datasetName: c.source!,
        task: 'segmentation',
        model: { name: manifest.name, version: manifest.version, sha256: modelSha },
        case: {
          caseId: c.case_id!,
          imageName: `${c.source}/${c.case_id}/ct.nii.gz`,
          imageSha256: sha(ctRaw),
          referenceName: `${c.source}/${c.case_id}/gt (1 whole liver, 2 tumour)`,
          meta: { modality: 'CT', bodyPart: 'LIVER', contrast: true, sliceThicknessMm: vol.spacing[2] },
        },
        runtime: { provider: 'cpu (onnxruntime-node)', loadMs, inferMs, metricMs, totalMs: performance.now() - t0 },
        segmentation: seg,
        env: { provider: 'cpu', wasmThreads: threads, appVersion: 'headless-runner' },
        createdAt: new Date().toISOString(),
        appVersion: 'headless-runner',
      };
      appendFileSync(ndjson, JSON.stringify(rec) + '\n');
      if (saveMasks) writeFileSync(join(outDir, 'masks', `${id}__${c.case_id}.nii.gz`), maskNifti(ctRaw, pred));
      log(
        `${id}\t${c.source}\t${c.case_id}\tliverDice=${seg[0]!.dice.toFixed(4)}\t` +
          (seg[1] ? `tumourDice=${seg[1].dice.toFixed(4)}\t` : '') +
          `HD95=${seg[0]!.hd95Mm.toFixed(1)}\tinfer=${(inferMs / 1000).toFixed(1)}s`
      );
    } catch (e) {
      log(`FAIL ${id} ${c.case_id}: ${(e as Error).message}`);
    }
  }
  await session.release?.();
}
log('DONE');
