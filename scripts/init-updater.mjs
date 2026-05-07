#!/usr/bin/env node
/**
 * Bootstrap the auto-updater signing keypair.
 *
 * Tauri verifies update bundles against an Ed25519 signature whose public key
 * is embedded in the app at compile time. The matching private key signs new
 * bundles in CI and must NEVER be committed.
 *
 * What this script does:
 *   1. Generates a fresh keypair via `tauri signer generate -w ./tauri-signing.key`
 *      (the CLI prompts for a password). Tauri writes:
 *         tauri-signing.key       (encrypted private key)
 *         tauri-signing.key.pub   (public key)
 *   2. Reads the public key from the .pub file (skipping the
 *      "untrusted comment" header line) and patches
 *      src-tauri/tauri.conf.json's `plugins.updater.pubkey`.
 *   3. Prints the GitHub secrets you need to add: `TAURI_SIGNING_PRIVATE_KEY`
 *      (the contents of tauri-signing.key) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
 *
 * After running this script:
 *   - Commit the updated tauri.conf.json (the public key is safe to publish).
 *   - Add the two GitHub Actions secrets.
 *   - Move tauri-signing.key out of the repo (it is .gitignore'd, so it
 *     can't accidentally be committed, but moving is cleaner).
 *
 * Re-run only when rotating the key. Existing installs trust the old public
 * key; rotating means existing users must do a manual re-install once.
 *
 * Usage:
 *   node scripts/init-updater.mjs
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), '..');

const KEY_FILE = resolve(REPO, 'tauri-signing.key');
const KEY_PUB_FILE = resolve(REPO, 'tauri-signing.key.pub');
const TAURI_CONF = resolve(REPO, 'src-tauri/tauri.conf.json');

if (existsSync(KEY_FILE) || existsSync(KEY_PUB_FILE)) {
  process.stderr.write(
    '✗ tauri-signing.key (or .key.pub) already exists in the repo root.\n' +
      '  Refusing to overwrite — move them aside first if you really intend\n' +
      '  to rotate the key (a re-install will be required for every existing\n' +
      '  desktop install).\n'
  );
  process.exit(2);
}

process.stdout.write('▶ Generating Tauri updater keypair via "npx tauri signer generate"…\n');
process.stdout.write('  You will be prompted for a password — keep it safe.\n\n');

// Run the generator with stdio inherited so the password prompt works
// interactively. We don't try to capture stdout — different tauri-cli
// versions print the public key in different shapes; reading the .pub file
// after the fact is reliable across all of them.
const r = spawnSync('npx', ['--yes', 'tauri', 'signer', 'generate', '-w', KEY_FILE], {
  cwd: REPO,
  stdio: 'inherit',
});
if (r.status !== 0) {
  process.stderr.write(`\n✗ tauri signer generate exited with code ${r.status}.\n`);
  process.exit(1);
}

if (!existsSync(KEY_PUB_FILE)) {
  process.stderr.write(
    `\n✗ Expected ${KEY_PUB_FILE} to exist after key generation, but it does not.\n` +
      `  Check the output above for errors.\n`
  );
  process.exit(1);
}

// The .pub file is in minisign format, e.g.:
//   untrusted comment: minisign public key 1234ABCD
//   RWQz...base64...==
// We want the second non-comment line, all on one line, no whitespace.
const pubRaw = readFileSync(KEY_PUB_FILE, 'utf-8');
const pubkey = pubRaw
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.startsWith('untrusted comment'))
  .join('')
  .trim();

if (!pubkey) {
  process.stderr.write(
    `\n✗ Could not extract a public key from ${KEY_PUB_FILE}.\n` +
      `  File contents:\n${pubRaw}\n`
  );
  process.exit(1);
}

const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf-8'));
conf.plugins ??= {};
conf.plugins.updater ??= {};
conf.plugins.updater.pubkey = pubkey;
writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + '\n');

// Detect the "git remote" so we can print the correct settings URL.
let secretsUrl = 'https://github.com/<owner>/<repo>/settings/secrets/actions';
try {
  const remote = execSync('git remote get-url origin', {
    cwd: REPO,
    encoding: 'utf-8',
  }).trim();
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (m) secretsUrl = `https://github.com/${m[1]}/${m[2]}/settings/secrets/actions`;
} catch {
  // best-effort
}

process.stdout.write(`\n✓ Public key written into src-tauri/tauri.conf.json\n`);
process.stdout.write(`✓ Private key kept at ${KEY_FILE} (DO NOT COMMIT — already gitignored)\n\n`);
process.stdout.write('Next steps:\n');
process.stdout.write(`  1. Open ${secretsUrl}\n`);
process.stdout.write('     and add these two repository secrets:\n');
process.stdout.write('       TAURI_SIGNING_PRIVATE_KEY            = (full contents of tauri-signing.key)\n');
process.stdout.write('       TAURI_SIGNING_PRIVATE_KEY_PASSWORD   = (the password you just set)\n\n');
process.stdout.write('     Or via gh CLI (in this directory):\n');
process.stdout.write('       gh secret set TAURI_SIGNING_PRIVATE_KEY < tauri-signing.key\n');
process.stdout.write('       gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD\n\n');
process.stdout.write('  2. Commit the updated tauri.conf.json (public key is safe to publish):\n');
process.stdout.write('       git add src-tauri/tauri.conf.json\n');
process.stdout.write('       git commit -m "chore: embed updater public key"\n');
process.stdout.write('       git push\n\n');
process.stdout.write('  3. Move tauri-signing.key + .key.pub somewhere safe outside the repo:\n');
process.stdout.write('       mv tauri-signing.key{,.pub} ~/.tamias-signing/\n\n');
process.stdout.write('  4. Cut your first release:\n');
process.stdout.write('       node scripts/release.mjs minor\n');
