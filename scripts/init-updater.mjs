#!/usr/bin/env node
/**
 * Bootstrap the auto-updater signing keypair.
 *
 * Tauri verifies update bundles against an Ed25519 signature whose public key
 * is embedded in the app at compile time. The matching private key signs new
 * bundles in CI and must NEVER be committed.
 *
 * What this script does:
 *   1. Generates a fresh keypair via `tauri signer generate` (writes the
 *      private key to ./tauri-signing.key, prompts for a password).
 *   2. Patches src-tauri/tauri.conf.json's `plugins.updater.pubkey` field
 *      with the generated public key.
 *   3. Prints the secrets you need to add to GitHub: `TAURI_SIGNING_PRIVATE_KEY`
 *      (the contents of tauri-signing.key) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
 *
 * After running this script:
 *   - Commit the updated tauri.conf.json (the public key is safe to publish).
 *   - Add the two GitHub Actions secrets.
 *   - Optionally delete tauri-signing.key from disk once it's stored elsewhere.
 *
 * Re-run only when rotating the key. Existing installs trust the old public
 * key; rotating means existing users must do a manual re-install once.
 *
 * Usage:
 *   node scripts/init-updater.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), '..');

const KEY_FILE = resolve(REPO, 'tauri-signing.key');
const TAURI_CONF = resolve(REPO, 'src-tauri/tauri.conf.json');

if (existsSync(KEY_FILE)) {
  process.stderr.write(
    '✗ tauri-signing.key already exists. Refusing to overwrite.\n' +
      '  Move/delete it first if you really intend to rotate the key.\n'
  );
  process.exit(2);
}

process.stdout.write('▶ Generating Tauri updater keypair via "npx tauri signer generate"…\n');
process.stdout.write('  You will be prompted for a password — keep it safe.\n\n');

let out;
try {
  out = execSync(`npx --yes tauri signer generate -w "${KEY_FILE}"`, {
    cwd: REPO,
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
} catch (e) {
  process.stderr.write(`✗ tauri signer generate failed: ${e?.message ?? e}\n`);
  process.exit(1);
}

const pubkeyMatch = out.match(/Public Key.*?:\s*([A-Za-z0-9+/=]+)/);
if (!pubkeyMatch) {
  process.stderr.write('✗ Could not parse public key from "tauri signer generate" output.\n');
  process.stderr.write(out + '\n');
  process.exit(1);
}
const pubkey = pubkeyMatch[1];

const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf-8'));
conf.plugins ??= {};
conf.plugins.updater ??= {};
conf.plugins.updater.pubkey = pubkey;
writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + '\n');

process.stdout.write(`\n✓ Public key written to src-tauri/tauri.conf.json\n`);
process.stdout.write(`✓ Private key written to tauri-signing.key (DO NOT COMMIT)\n\n`);
process.stdout.write('Next steps:\n');
process.stdout.write('  1. Add these two GitHub Actions secrets to ArioMoniri/semikap:\n');
process.stdout.write(`       TAURI_SIGNING_PRIVATE_KEY            = (contents of tauri-signing.key)\n`);
process.stdout.write(`       TAURI_SIGNING_PRIVATE_KEY_PASSWORD   = (the password you just set)\n\n`);
process.stdout.write('  2. Commit src-tauri/tauri.conf.json (public key is safe to publish).\n');
process.stdout.write('  3. Optionally delete tauri-signing.key once it is stored in a password manager / vault.\n');
process.stdout.write('  4. Cut a release with:  node scripts/release.mjs minor\n');
