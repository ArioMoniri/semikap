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
 *   2. Reads the public key from the .pub file and extracts the *raw* base64
 *      key bytes (NOT the base64-wrapped whole-file form). Tauri's updater
 *      expects the raw form in `plugins.updater.pubkey`.
 *      Two .pub-file shapes are handled:
 *        a) Two-line minisign:   `untrusted comment: ...\n<base64-key>`
 *        b) Single-line wrapped: `<base64-encoded-whole-file>` (newer tauri-cli)
 *   3. Patches src-tauri/tauri.conf.json's `plugins.updater.pubkey`.
 *   4. Prints the GitHub secrets to add and the next steps.
 *
 * Usage:
 *   node scripts/init-updater.mjs
 */

import { spawnSync, execSync } from 'node:child_process';
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
    `\n✗ Expected ${KEY_PUB_FILE} to exist after key generation, but it does not.\n`
  );
  process.exit(1);
}

/**
 * Extract the raw base64 public key from the .pub file. Handles both:
 *  a) two-line minisign format (`untrusted comment: ...\n<base64>`), or
 *  b) single-line base64-wrapped form where the whole minisign file is
 *     itself base64-encoded into one line (some tauri-cli versions).
 *
 * Tauri's `plugins.updater.pubkey` expects format (a)'s second line —
 * the raw base64 key bytes only. Format (b) confuses minisign-verify and
 * fails the build with "Invalid symbol N, offset M".
 */
function extractRawPubkey(pubFileContent) {
  const trimmed = pubFileContent.trim();

  // Case (a): looks like 2-line minisign (starts with "untrusted comment").
  if (trimmed.startsWith('untrusted comment')) {
    const dataLine = trimmed
      .split(/\r?\n/)
      .find((l) => l.trim() && !l.startsWith('untrusted comment'));
    if (dataLine) return dataLine.trim();
  }

  // Case (b): single-line wrapped — try to base64-decode and recurse.
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
    if (decoded.includes('untrusted comment')) {
      return extractRawPubkey(decoded);
    }
  } catch {
    // not base64 — fall through
  }

  // Last resort: assume the whole file IS the raw key (minus whitespace).
  return trimmed.replace(/\s+/g, '');
}

const pubkey = extractRawPubkey(readFileSync(KEY_PUB_FILE, 'utf-8'));
if (!pubkey || /[^A-Za-z0-9+/=]/.test(pubkey)) {
  process.stderr.write(
    `\n✗ Extracted pubkey contains non-base64 characters; refusing to write it.\n` +
      `  Pubkey: ${pubkey}\n` +
      `  Open ${KEY_PUB_FILE} and patch tauri.conf.json by hand.\n`
  );
  process.exit(1);
}

const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf-8'));
conf.plugins ??= {};
conf.plugins.updater ??= {};
conf.plugins.updater.pubkey = pubkey;
writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + '\n');

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

process.stdout.write(`\n✓ Public key written into src-tauri/tauri.conf.json (raw form, ${pubkey.length} chars)\n`);
process.stdout.write(`✓ Private key kept at ${KEY_FILE} (DO NOT COMMIT — already gitignored)\n\n`);
process.stdout.write('Next steps:\n');
process.stdout.write(`  1. Open ${secretsUrl} and add these two repository secrets:\n`);
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
