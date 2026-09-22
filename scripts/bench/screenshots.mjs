// Capture manuscript/README screenshots of the TAMIAS catalogue + comparison UI.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/bench/screenshots.mjs --url http://localhost:4173 --records <records.ndjson> --out <dir> \
//        [--case HCC_002] [--load-case] [--model lms3d_segformer --run]
//
// Uses the globally installed Playwright + the preinstalled Chromium.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true;
};
const url = arg('url', 'http://localhost:4173');
const out = arg('out', 'screenshots');
const records = arg('records');
const caseId = arg('case', 'HCC_002');
const loadCase = arg('load-case', false);
const modelId = arg('model');
const run = arg('run', false);
const dark = arg('dark', false);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // Behind an egress proxy (CI/sandbox) route the browser through it too.
  args: [
    '--enable-unsafe-webgpu',
    '--use-angle=swiftshader',
    ...(process.env.HTTPS_PROXY
      ? [`--proxy-server=${process.env.HTTPS_PROXY.replace(/^http:\/\//, '')}`, '--proxy-bypass-list=localhost;127.0.0.1']
      : []),
  ],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
await page.goto(url, { waitUntil: 'networkidle' });
const shot = async (name, locator) => {
  const p = join(out, `${name}.png`);
  await (locator ?? page).screenshot({ path: p, ...(locator ? {} : { fullPage: false }) });
  console.log('saved', p);
};
const openSection = async (title) => {
  const btn = page.getByRole('button', { name: new RegExp(`^${title}`) }).first();
  await btn.scrollIntoViewIfNeeded();
  const expanded = await btn.getAttribute('aria-expanded');
  if (expanded !== 'true') await btn.click();
};

// 1) Catalogue
await openSection('Catalogue');
const cat = page.getByTestId('catalogue-panel');
await cat.waitFor();
await page.waitForTimeout(2500); // release index fetch
await shot('01_catalogue_panel', cat);

// 2) Load an HCC-TACE-Seg case straight from TCIA/IDC (CT + DICOM-SEG GT)
if (loadCase) {
  await cat.getByLabel('Case').selectOption(caseId);
  await cat.getByRole('button', { name: /Load CT \+ GT/ }).click();
  await cat.locator('text=/GT set as the Benchmark reference|Error|failed|cannot|affine/i').first().waitFor({ timeout: 600_000 });
  await page.waitForTimeout(3000);
  await shot('02_hcc_case_loaded_with_gt');
}

// 3) Load a catalogue model and run it in-browser
if (modelId) {
  await cat.getByTestId(`catalog-model-${modelId}`).getByRole('button', { name: /Load/ }).click();
  await cat.locator('text=/Loaded .*Run inference|failed|blocked/i').first().waitFor({ timeout: 900_000 });
  await shot('03_model_loaded', cat);
  if (run) {
    await openSection('Inference');
    await page.getByRole('button', { name: /^Run/ }).first().click();
    await page.locator('text=/done|Done|elapsed/').first().waitFor({ timeout: 3_600_000 });
    await page.waitForTimeout(3000);
    await shot('04_inference_overlay');
  }
}

// 4) Comparison report from benchmark records
if (records) {
  await openSection('Benchmark');
  const panel = page.getByTestId('compare-panel');
  await panel.waitFor();
  await panel.locator('input[type=file]').setInputFiles(records);
  await panel.locator('text=/Imported \\d+ records/').waitFor();
  await shot('05_compare_panel_sidebar', panel);
  await panel.getByTestId('compare-open-report').click();
  const report = page.getByTestId('compare-report');
  await report.waitFor();
  await page.waitForTimeout(800);
  for (const [label, metric, tag] of [
    ['1', 'dice', 'liver_dice'],
    ['1', 'hd95Mm', 'liver_hd95'],
    ['2', 'dice', 'tumour_dice'],
  ]) {
    await report.getByLabel('Structure').selectOption(label);
    await report.getByLabel('Metric').selectOption(metric);
    await page.waitForTimeout(500);
    const blocks = report.locator('[data-testid^="compare-dataset-"]');
    const n = await blocks.count();
    for (let i = 0; i < n; i++) {
      const id = (await blocks.nth(i).getAttribute('data-testid')).replace('compare-dataset-', '');
      await blocks.nth(i).scrollIntoViewIfNeeded();
      await shot(`06_report_${tag}_${id}`, blocks.nth(i));
    }
    const cross = report.getByTestId('compare-cross-dataset');
    if (await cross.count()) {
      await cross.scrollIntoViewIfNeeded();
      await shot(`07_cross_dataset_${tag}`, cross);
    }
  }
}
await browser.close();
