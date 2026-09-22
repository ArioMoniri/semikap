/**
 * Real-data cross-check of the in-app HCC-TACE-Seg ground-truth path:
 * IDC listing → download → DICOM-SEG geometry parse → mapSegFramesToGrid,
 * compared against an independently produced (highdicom) GT NIfTI on the
 * same CT grid. Usage: vite-node scripts/bench/verify-seg-mapping.ts <dataDir> [caseIds...]
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { CATALOG_DATASETS } from '../../src/lib/catalog/catalog';
import { listIdcSeriesUrls } from '../../src/lib/catalog/idc';
import { fetchIdcSeriesFiles } from '../../src/lib/catalog/load';
import { fetchCatalogAsset } from '../../src/lib/catalog/fetch';
import { parseDicomSegGeometry, mapSegFramesToGrid, classifySegment } from '../../src/lib/datasets/seg-to-grid';
import { niftiDataToVolume } from '../../src/lib/datasets/nifti-volume';
import { niftiDataToMask, parseNiftiHeader } from '../../src/lib/datasets/nifti-mask';
import { groupMask } from '../../src/lib/metrics/label-groups';

function dice(a: Uint8Array, b: Uint8Array): number {
  let tp = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]! ? 1 : 0, y = b[i]! ? 1 : 0; tp += x & y; sa += x; sb += y; }
  return sa + sb === 0 ? 1 : (2 * tp) / (sa + sb);
}
function readMask(p: string): Uint8Array {
  const buf = gunzipSync(readFileSync(p));
  return niftiDataToMask(buf, parseNiftiHeader(buf));
}

const [dataDir, ...only] = process.argv.slice(2);
const ds = CATALOG_DATASETS.find((d) => d.id === 'hcc-tace-seg')!;
if (ds.access.kind !== 'idc-s3') throw new Error('bad dataset');
let worst = 1;
for (const c of ds.access.cases) {
  if (only.length && !only.includes(c.caseId)) continue;
  const dir = join(dataDir!, 'hcc_tace_seg', c.caseId);
  const ct = niftiDataToVolume(gunzipSync(readFileSync(join(dir, 'ct.nii.gz'))));
  const segFiles = await fetchIdcSeriesFiles(c.segSeriesUuid, {
    list: (u) => listIdcSeriesUrls(u),
    fetchAsset: (u) => fetchCatalogAsset(u, { tauriInvoke: null }),
  });
  const seg = parseDicomSegGeometry(segFiles[0]!.bytes);
  const mapped = mapSegFramesToGrid(
    seg,
    { dims: ct.dims, srowX: ct.srowX!, srowY: ct.srowY!, srowZ: ct.srowZ! },
    (s) => classifySegment(seg.segments.get(s) ?? '')
  );
  const dl = dice(groupMask(mapped.mask, [1, 2]), readMask(join(dir, 'gt_liver.nii.gz')));
  const dt = dice(groupMask(mapped.mask, [2]), readMask(join(dir, 'gt_tumor.nii.gz')));
  worst = Math.min(worst, dl, dt);
  console.log(`${c.caseId}\tsegments=[${[...seg.segments.values()].join('|')}]\tframes=${seg.frames.length}\toutOfGrid=${mapped.outOfGridFrames}\tDice(liver)=${dl.toFixed(5)}\tDice(tumour)=${dt.toFixed(5)}`);
}
console.log(`WORST ${worst.toFixed(5)}`);
if (worst < 0.999) process.exitCode = 1;
