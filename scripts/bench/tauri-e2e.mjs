// End-to-end drive of the TAMIAS *desktop* app (Tauri) through tauri-driver +
// WebKitWebDriver: catalogue index via the native downloader, HCC-TACE-Seg case
// from TCIA/IDC, a Zenodo model downloaded natively, inference, scoring, and
// the comparison report — with screenshots at each step.
//
//   Xvfb :99 & export DISPLAY=:99; tauri-driver --port 4444 &
//   node scripts/bench/tauri-e2e.mjs --app src-tauri/target/release/tamias --out shots/ \
//        [--case HCC_002] [--model lms3d_segformer] [--records records.ndjson]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : process.argv[i + 1];
};
const app = resolve(arg('app', 'src-tauri/target/release/tamias'));
const out = arg('out', 'shots-desktop');
const caseId = arg('case', 'HCC_002');
const modelId = arg('model', 'lms3d_segformer');
const records = arg('records');
const WD = arg('driver', 'http://127.0.0.1:4444');
mkdirSync(out, { recursive: true });

async function wd(method, path, body) {
  const r = await fetch(`${WD}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${path}: ${j.value.error} ${j.value.message}`);
  return j.value;
}
// W3C element key; WebKitWebDriver has been seen to use a variant, so learn it from responses.
let ELEM = 'element-6066-11e4-a52e-4f735466cecc';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const session = await wd('POST', '/session', {
  capabilities: { alwaysMatch: { 'tauri:options': { application: app } } },
});
const sid = session.sessionId;
const S = (p) => `/session/${sid}${p}`;
const elemId = (v) => {
  const k = Object.keys(v).find((x) => x.startsWith('element-6066')) ?? ELEM;
  ELEM = k;
  return v[k];
};
const find = async (xpath) => elemId(await wd('POST', S('/element'), { using: 'xpath', value: xpath }));
const findAll = async (xpath) => (await wd('POST', S('/elements'), { using: 'xpath', value: xpath })).map(elemId);
const click = async (id) => wd('POST', S(`/element/${id}/click`), {});
const js = (script, args = []) => wd('POST', S('/execute/sync'), { script, args });
const text = async (xpath) => js(`const n=document.evaluate(arguments[0],document,null,9,null).singleNodeValue;return n?n.innerText:''`, [xpath]);
const shot = async (name) => {
  const b64 = await wd('GET', S('/screenshot'));
  writeFileSync(join(out, `${name}.png`), Buffer.from(b64, 'base64'));
  log('saved', name);
};
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
};
const openSection = async (title) => {
  const b = await find(`//button[contains(normalize-space(.), '${title}')]`);
  await js('arguments[0].scrollIntoView({block:"center"})', [{ [ELEM]: b }]);
  const exp = await js('return arguments[0].getAttribute("aria-expanded")', [{ [ELEM]: b }]);
  if (exp !== 'true') await click(b);
};
const panel = "//*[@data-testid='catalogue-panel']";

try {
  await waitFor(() => find("//button[contains(normalize-space(.), 'Catalogue')]"), 180_000, 'app ready');
  await js('window.resizeTo?.(1600,1000)');
  await openSection('Catalogue');
  await js(`document.querySelector('[data-testid=catalogue-panel]').scrollIntoView()`);
  const idx = await waitFor(async () => {
    const t = await text(panel);
    return /index: (GitHub release|HF mirror)/.test(t) ? t.match(/index: [^\n]+/)[0] : null;
  }, 120_000, 'release index');
  log('catalogue', idx);
  await shot('d01_catalogue_index_loaded_natively');

  // HCC-TACE-Seg case straight from TCIA (IDC bucket)
  await js(
    `const s=document.querySelector('[data-testid=catalogue-panel] select[aria-label=Case]');s.value=arguments[0];s.dispatchEvent(new Event('change',{bubbles:true}))`,
    [caseId]
  );
  await click(await find(`${panel}//button[contains(., 'Load CT + GT')]`));
  const note = await waitFor(async () => {
    const t = await text(panel);
    return /GT set as the Benchmark reference|failed|cannot|Error/i.test(t) ? t : null;
  }, 900_000, 'case load');
  log('case', (note.match(/Loaded [^\n]+/) || ['?'])[0]);
  await shot('d02_hcc_case_with_gt_from_tcia');

  // Zenodo model through the native downloader
  await click(await find(`//*[@data-testid='catalog-model-${modelId}']//button[contains(., 'Load')]`));
  await waitFor(async () => /Loaded .*Run inference|could not|mismatch|failed/i.test(await text(panel)), 900_000, 'model load');
  await shot('d03_model_downloaded_natively');

  // Inference
  await openSection('Inference');
  await click(await find("//button[normalize-space(.)='Run']"));
  await waitFor(async () => /done|elapsed|Done|voxels/i.test(await text("//*[contains(@class,'card')][.//*[contains(., 'Run inference')]]")), 3_600_000, 'inference');
  await new Promise((r) => setTimeout(r, 4000));
  await shot('d04_inference_overlay');

  // Score vs catalogue GT
  await openSection('Benchmark');
  const score = await find("//button[contains(., 'Score vs reference')]");
  await js('arguments[0].scrollIntoView({block:"center"})', [{ [ELEM]: score }]);
  await click(score);
  await waitFor(async () => /Scored: macro Dice/.test(await js('return document.body.innerText')), 600_000, 'score');
  log('score', (await js('return document.body.innerText')).match(/Scored: macro Dice [^\n]+/)?.[0]);
  await shot('d05_scored_vs_tcia_gt');

  if (records) {
    const input = await find("//*[@data-testid='compare-panel']//input[@type='file']");
    await wd('POST', S(`/element/${input}/value`), { text: resolve(records) });
    await waitFor(async () => /Imported \d+ records/.test(await text("//*[@data-testid='compare-panel']")), 60_000, 'import');
    await click(await find("//*[@data-testid='compare-open-report']"));
    await new Promise((r) => setTimeout(r, 2500));
    await shot('d06_comparison_report');
    const blocks = await findAll("//*[@data-testid='compare-report']//*[starts-with(@data-testid,'compare-')]");
    for (let i = 0; i < blocks.length; i++) {
      await js('arguments[0].scrollIntoView({block:"start"})', [{ [ELEM]: blocks[i] }]);
      await new Promise((r) => setTimeout(r, 800));
      await shot(`d07_report_section_${i + 1}`);
    }
  }
} finally {
  await wd('DELETE', S('')).catch(() => {});
}
