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
 *     [--postprocess none|fov|lcc|fov,lcc] [--min-lesion-ml 0.5]
 *
 * --postprocess is applied to the prediction before scoring and stored in each
 * record; one setting = one records file (records.ndjson for none, else
 * records_<ops>.ndjson). Saved masks are always the raw model output, so
 * scripts/bench/rescore.ts can derive any other variant without re-inference.
 *
 * Ensemble manifests (a <id>.json with an `ensemble` block and no <id>.onnx, e.g.
 * nnunet_liver_lits_ens5.json) are run too: every member <member>.onnx is read from
 * the same --models dir and sha256-verified, all member sessions are created up front
 * (the runner has the memory; CPU arenas off so 5 sessions don't each pin a
 * high-water heap), and each tile runs every member (× 8 mirror variants when TTA
 * is on — `--ensemble-tta off` disables it). The record's model is
 * { name: '<manifest name> (+mirror TTA)', sha256: sha256(ensembleDigestInput) }, i.e.
 * sha256 over the member sha256s joined by '\n' (+ '\ntta=mirror' with TTA) —
 * see src/lib/inference/manifest.ts ensembleDigestInput.
 *
 * cases.csv columns used: source, case_id; files <data>/<source>/<case_id>/{ct,gt_liver,gt_tumor}.nii.gz
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import * as ort from 'onnxruntime-web'; // aliased to onnxruntime-node by vite.config.ts
import { parseManifest } from '../../src/lib/inference/manifest';
import { preparePreprocessing } from '../../src/lib/inference/preprocess';
import {
  slidingWindowInference,
  slidingWindowEnsembleInference,
  preloadedMembers,
} from '../../src/lib/inference/sliding-window';
import { ensembleDigestInput, ensembleMemberFile, ensembleRunName } from '../../src/lib/inference/manifest';
import { resampleNearest } from '../../src/lib/inference/postprocess';
import { axisCodes, planReorientation, invertReorientation, isIdentityPlan } from '../../src/lib/inference/orient';
import { niftiDataToVolume } from '../../src/lib/datasets/nifti-volume';
import { niftiDataToMask, parseNiftiHeader } from '../../src/lib/datasets/nifti-mask';
import { scoreLiverTumourCase, groupsForModelLabels } from '../../src/lib/metrics/label-groups';
import { applyPostprocess, parsePostprocess } from '../../src/lib/metrics/postprocess';
import { DEFAULT_MIN_LESION_ML } from '../../src/lib/metrics/lesions';
import type { BenchmarkRecord } from '../../src/lib/benchmark/types';
import { canonicalDatasetId } from '../../src/lib/benchmark/compare';
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
const postprocess = parsePostprocess(arg('postprocess', 'none')!);
const minLesionMl = Number(arg('min-lesion-ml', String(DEFAULT_MIN_LESION_ML)));
if (!dataDir || !modelsDir || !outDir) throw new Error('need --data --models --out');
mkdirSync(join(outDir, 'masks'), { recursive: true });

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Hardware / runtime of this run, stored in every record for the Methods and runtime tables. */
const ortVersion = (() => {
  try {
    const dir = process.env.ORT_NODE;
    return dir ? `onnxruntime-node ${JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version}` : undefined;
  } catch {
    return undefined;
  }
})();
const hostEnv = {
  runner: 'headless' as const,
  cpuCores: cpus().length,
  cpuModel: cpus()[0]?.model?.trim(),
  memoryGb: Math.round((totalmem() / 2 ** 30) * 10) / 10,
  os: `${platform()} ${release()}`,
  ortVersion,
};

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
// Ensemble manifests: <id>.json with an `ensemble` block and no <id>.onnx of their own.
for (const f of readdirSync(modelsDir)) {
  const id = basename(f, '.json');
  if (!f.endsWith('.json') || existsSync(join(modelsDir, `${id}.onnx`)) || (only && !only.includes(id))) continue;
  try {
    const raw = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')) as { ensemble?: unknown };
    if (raw && typeof raw === 'object' && raw.ensemble) models.push(id);
  } catch {
    /* not a manifest */
  }
}
const ensembleTta = arg('ensemble-tta', 'manifest') !== 'off';

const ndjson = join(outDir, postprocess.length ? `records_${postprocess.join('_')}.ndjson` : 'records.ndjson');
const log = (s: string) => {
  console.log(s);
  appendFileSync(join(outDir, 'run.log'), s + '\n');
};
log(`models=${models.join(',')} cases=${cases.length} threads=${threads} postprocess=${postprocess.join('+') || 'none'}`);

/** Load a single model or an ensemble (members from the same dir) into a tile runner. */
async function loadModel(id: string) {
  const manifest: ModelManifest = parseManifest(JSON.parse(readFileSync(join(modelsDir, `${id}.json`), 'utf8')));
  const ens = manifest.ensemble;
  if (!ens) {
    const bytes = new Uint8Array(readFileSync(join(modelsDir, `${id}.onnx`)));
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['cpu'],
      intraOpNumThreads: threads,
      graphOptimizationLevel: 'all',
    });
    return {
      manifest,
      modelName: manifest.name,
      modelSha: sha(bytes),
      infer: (data: Float32Array, dims: [number, number, number], patch: [number, number, number], overlap: number) =>
        slidingWindowInference(session as never, data, dims, { patch, overlap }),
      release: async () => {
        await session.release?.();
      },
    };
  }
  const tta = ensembleTta && ens.tta === 'mirror';
  const sessions: ort.InferenceSession[] = [];
  for (const m of ens.members) {
    const bytes = new Uint8Array(readFileSync(join(modelsDir, ensembleMemberFile(m))));
    if (sha(bytes) !== m.sha256) throw new Error(`${id}: member ${m.id} sha256 does not match the manifest`);
    sessions.push(
      await ort.InferenceSession.create(bytes, {
        executionProviders: ['cpu'],
        intraOpNumThreads: threads,
        graphOptimizationLevel: 'all',
        enableCpuMemArena: false,
        enableMemPattern: false,
      })
    );
  }
  return {
    manifest,
    modelName: ensembleRunName(manifest, tta),
    modelSha: createHash('sha256').update(ensembleDigestInput(ens, tta), 'utf8').digest('hex'),
    infer: (data: Float32Array, dims: [number, number, number], patch: [number, number, number], overlap: number) =>
      slidingWindowEnsembleInference(preloadedMembers(sessions as never), data, dims, {
        patch,
        overlap,
        aggregation: ens.aggregation,
        tta: tta ? 'mirror' : null,
      }),
    release: async () => {
      for (const s of sessions) await s.release?.();
    },
  };
}

for (const id of models) {
  const tl = performance.now();
  const loaded = await loadModel(id);
  const { manifest, modelSha, modelName } = loaded;
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
      const sw = await loaded.infer(pre.data, pre.dims, manifest.inference.patch, manifest.inference.overlap);
      const inferMs = performance.now() - ti;
      const oriented = resampleNearest(sw.mask, sw.dims, pre.orientedDims);
      const pred = plan ? invertReorientation(oriented, pre.orientedDims, plan).data : oriented;

      const liverRaw = readGz(join(dir, 'gt_liver.nii.gz'));
      const tumourRaw = readGz(join(dir, 'gt_tumor.nii.gz'));
      const liver = niftiDataToMask(liverRaw, parseNiftiHeader(liverRaw));
      const tumour = niftiDataToMask(tumourRaw, parseNiftiHeader(tumourRaw));
      const ref = new Uint8Array(liver.length);
      for (let i = 0; i < ref.length; i++) ref[i] = tumour[i] ? 2 : liver[i] ? 1 : 0;
      // Map the model's own label space (e.g. BTCV liver=6, nnU-Net liver=8/tumour=9) onto
      // whole liver (1) and tumour (2); the tumour group only exists for models with a tumour class.
      const groups = groupsForModelLabels(manifest.output.labels);
      const tm = performance.now();
      const scored = applyPostprocess(pred, vol.voxels, vol.dims, groups[0]!.predMembers, postprocess);
      const { segmentation: seg, lesions } = scoreLiverTumourCase(ref, scored, vol.dims, vol.spacing, groups, { minLesionMl });
      const metricMs = performance.now() - tm;

      const rec: BenchmarkRecord = {
        schema: 'tamias.benchmark.v1',
        id: randomUUID(),
        profileId: 'default',
        datasetName: canonicalDatasetId(c.source!),
        task: 'segmentation',
        model: { name: modelName, version: manifest.version, sha256: modelSha },
        case: {
          caseId: c.case_id!,
          imageName: `${c.source}/${c.case_id}/ct.nii.gz`,
          imageSha256: sha(ctRaw),
          referenceName: `${c.source}/${c.case_id}/gt (1 whole liver, 2 tumour)`,
          meta: { modality: 'CT', bodyPart: 'LIVER', contrast: true, sliceThicknessMm: vol.spacing[2] },
        },
        runtime: { provider: 'cpu (onnxruntime-node)', loadMs, inferMs, metricMs, totalMs: performance.now() - t0 },
        segmentation: seg,
        ...(postprocess.length ? { postprocess: [...postprocess] } : {}),
        ...(lesions ? { lesions } : {}),
        env: {
          provider: 'cpu',
          wasmThreads: threads,
          appVersion: 'headless-runner',
          ...hostEnv,
          peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        },
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
  await loaded.release();
}
log('DONE');
