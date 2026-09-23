// End-to-end: the in-app benchmark a user runs by themselves, with screenshots.
//   Examples → Bundle: benchmark kit → Open kit → Catalogue batch (models added from disk) → Run →
//   live results → Benchmark comparison report (statistics) → mask comparison grid
//   (+ imported CI masks for all models on one case) → Export tables.
//
//   node scripts/bench/ui-batch-e2e.mjs --url http://localhost:4173 --out shots/ \
//     --models-dir <dir with <id>.onnx/.json> --kit hcc-quick [--records records.ndjson] \
//     [--masks-dir <dir with <model>__<case>.nii.gz>] [--mask-case HCC_002]
import { chromium } from 'playwright';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : process.argv[i + 1];
};
const url = arg('url', 'http://localhost:4173');
const out = arg('out', 'shots-batch');
const modelsDir = arg('models-dir');
const kit = arg('kit', 'hcc-quick');
const records = arg('records');
const masksDir = arg('masks-dir');
const maskCase = arg('mask-case', 'HCC_002');
// --skip-batch: load the mask case directly (Load CT + GT) instead of running the batch.
const skipBatch = process.argv.includes('--skip-batch');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: process.env.HTTPS_PROXY
    ? [`--proxy-server=${process.env.HTTPS_PROXY.replace(/^http:\/\//, '')}`, '--proxy-bypass-list=localhost;127.0.0.1']
    : [],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, deviceScaleFactor: 2 });
page.on('crash', () => console.error('[page] CRASHED'));
page.on('console', (m) => m.type() === 'error' && !/Content Security|Fetch API|TUNNEL|index\.json/.test(m.text()) && console.error('[page]', m.text().slice(0, 200)));
await page.addInitScript(() => {
  delete window.showOpenFilePicker;
});
await page.goto(url, { waitUntil: 'networkidle' });
const shot = async (name, locator) => {
  const path = join(out, `${name}.png`);
  if (!locator) await page.screenshot({ path });
  else
    await locator.screenshot({ path, timeout: 5000, animations: 'disabled' }).catch(async () => {
      // Element never "stable" (live viewer re-layout): clip its bounding box from the page instead.
      const b = await locator.boundingBox();
      if (!b) throw new Error(`no box for ${name}`);
      await page.screenshot({ path, clip: { x: Math.max(0, b.x), y: Math.max(0, b.y), width: b.width, height: b.height }, fullPage: true });
    });
  console.log('saved', name);
};
// Scroll without waiting for layout stability (the resized viewer keeps re-laying out).
const scrollTo = (loc) => loc.evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
const openSection = async (title) => {
  const btn = page.getByRole('button', { name: new RegExp(`^${title}`) }).first();
  await btn.scrollIntoViewIfNeeded();
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
};

// 1) Examples → Benchmark kits
await openSection('Examples');
// Benchmark kits live in the example loader's Bundle picker.
const bundleSelect = page.getByLabel('Bundle');
await bundleSelect.selectOption(`kit:${kit}`);
const kits = page.getByTestId('benchmark-kits');
await kits.waitFor();
const examplesCard = page.getByTestId('examples-card');
await examplesCard.scrollIntoViewIfNeeded();
await shot('b01_examples_benchmark_kits', examplesCard);
await page.getByTestId(`kit-${kit}`).click();
const cat = page.getByTestId('catalogue-panel');
await cat.waitFor();

// 2) Add the kit's models from disk (browser build: release host has no CORS)
const batch = page.getByTestId('catalog-batch');
if (modelsDir) {
  const files = readdirSync(modelsDir)
    .filter((f) => /\.(onnx|json)$/.test(f) && !f.startsWith('zenodo'))
    .map((f) => join(modelsDir, f));
  await page.getByTestId('catalog-add-local').setInputFiles(files);
  await cat.locator('text=/Added \\d+ model\\(s\\) from disk/').waitFor({ timeout: 600_000 });
}
await batch.scrollIntoViewIfNeeded();
await shot('b02_catalogue_batch_preconfigured', batch);

// 3) Run the batch
if (skipBatch) {
  await cat.getByLabel('Case').selectOption(maskCase);
  await cat.getByRole('button', { name: 'Load CT + GT' }).click();
  await cat.locator(`text=/Loaded ${maskCase}/`).waitFor({ timeout: 600_000 });
} else {
await page.getByTestId('batch-run').click();
await page.getByTestId('batch-status').locator('text=/^(Done|Cancelled|Batch failed)/').waitFor({ timeout: 4 * 3_600_000 });
console.log('batch:', await page.getByTestId('batch-status').innerText());
await batch.scrollIntoViewIfNeeded();
await shot('b03_batch_results', batch);
await shot('b04_viewer_after_batch');
}

// 4) Optional: import the full CI records so the report covers all models/datasets
await openSection('Benchmark');
const panel = page.getByTestId('compare-panel');
if (records) {
  await panel.locator('input[type=file]').first().setInputFiles(records);
  await panel.locator('text=/Imported \\d+ records/').waitFor();
}
await panel.scrollIntoViewIfNeeded();
await shot('b05_comparison_panel', panel);

// 5) Optional: import CI masks for every model on the loaded case → full mask grid
if (masksDir) {
  const mf = readdirSync(masksDir)
    .filter((f) => f.endsWith(`__${maskCase}.nii.gz`))
    .map((f) => join(masksDir, f));
  await cat.getByTestId('mask-import-input').setInputFiles(mf);
  await cat.locator('text=/Added \\d+ mask\\(s\\)/').waitFor({ timeout: 300_000 });
  console.log('masks:', await cat.locator('text=/Added \\d+ mask\\(s\\)/').innerText());
  console.log('compare panels in DOM:', await page.getByTestId('compare-panel').count());
}

// 6) Full report (statistics + mask comparison) in a tall viewport
await page.setViewportSize({ width: 1680, height: 2800 });
const openReport = panel.getByTestId('compare-open-report');
await scrollTo(openReport);
await openReport.evaluate((b) => b.click()); // DOM click: the sticky sidebar can report the button as not "stable"
const report = page.getByTestId('compare-report');
await report.waitFor();
await page.waitForTimeout(1000);
const blocks = report.locator('[data-testid^="compare-dataset-"], [data-testid="compare-cross-dataset"]');
for (let i = 0; i < (await blocks.count()); i++) {
  const id = await blocks.nth(i).getAttribute('data-testid');
  await scrollTo(blocks.nth(i));
  await shot(`b06_report_${id}`, blocks.nth(i));
}
const grid = report.getByTestId('mask-compare');
await scrollTo(grid);
const sel = grid.getByLabel('Mask comparison case');
if (await sel.count()) {
  for (const v of await sel.locator('option').evaluateAll((os) => os.map((o) => o.value))) {
    await sel.selectOption(v);
    await page.waitForTimeout(600);
    await shot(`b07_mask_compare_${v.replace(/\W+/g, '_')}`, grid);
  }
}
// 7) Export tables
const dl = page.waitForEvent('download');
await report.getByTestId('compare-export-tables').evaluate((b) => b.click());
const d = await dl;
await d.saveAs(join(out, 'tamias_benchmark_tables.zip'));
console.log('exported', d.suggestedFilename());
await browser.close();
