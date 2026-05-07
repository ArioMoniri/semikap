#!/usr/bin/env node
/**
 * Cut a TAMIAS release.
 *
 * What it does:
 *   1. Validates the working tree is clean and you're on `main` (or you pass --any-branch).
 *   2. Bumps `package.json` and `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` to a new semver.
 *   3. Commits the bump.
 *   4. Tags `v<version>`.
 *   5. (Optional) Pushes commit + tag.
 *
 * The push triggers `.github/workflows/tauri-release.yml`, which builds
 * desktop installers for macOS / Windows / Linux, signs them, and publishes
 * a draft GitHub Release with the auto-update `latest.json` manifest.
 *
 * Usage:
 *   node scripts/release.mjs patch          # 0.2.0 -> 0.2.1
 *   node scripts/release.mjs minor          # 0.2.1 -> 0.3.0
 *   node scripts/release.mjs major          # 0.3.0 -> 1.0.0
 *   node scripts/release.mjs 1.2.3          # explicit version
 *   node scripts/release.mjs patch --no-push   # don't push
 *   node scripts/release.mjs patch --any-branch  # allow non-main
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(__filename), '..');

const args = process.argv.slice(2);
if (args.length === 0) usage();
const bumpArg = args[0];
const noPush = args.includes('--no-push');
const anyBranch = args.includes('--any-branch');

function usage() {
  process.stderr.write(
    'Usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--no-push] [--any-branch]\n'
  );
  process.exit(1);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'], ...opts }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(REPO, path), 'utf-8'));
}

function writeJson(path, obj) {
  writeFileSync(resolve(REPO, path), JSON.stringify(obj, null, 2) + '\n');
}

function bump(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [maj, min, pat] = current.split('.').map((n) => parseInt(n, 10));
  switch (kind) {
    case 'patch':
      return `${maj}.${min}.${pat + 1}`;
    case 'minor':
      return `${maj}.${min + 1}.0`;
    case 'major':
      return `${maj + 1}.0.0`;
    default:
      usage();
      return '';
  }
}

// 1. Sanity checks.
const branch = sh('git rev-parse --abbrev-ref HEAD');
if (!anyBranch && branch !== 'main') {
  process.stderr.write(`✗ On branch "${branch}", not "main". Pass --any-branch to override.\n`);
  process.exit(2);
}
const dirty = sh('git status --porcelain');
if (dirty) {
  process.stderr.write('✗ Working tree is not clean:\n' + dirty + '\n');
  process.exit(2);
}

// 2. Read current version, compute new.
const pkg = readJson('package.json');
const current = pkg.version;
const next = bump(current, bumpArg);
process.stdout.write(`▶ ${current} → ${next}\n`);

// 3. Patch package.json
pkg.version = next;
writeJson('package.json', pkg);

// 4. Patch src-tauri/Cargo.toml (line-based; safe for the simple shape used here).
const cargoPath = resolve(REPO, 'src-tauri/Cargo.toml');
const cargo = readFileSync(cargoPath, 'utf-8').replace(
  /^version = ".+"$/m,
  `version = "${next}"`
);
writeFileSync(cargoPath, cargo);

// 5. Patch src-tauri/tauri.conf.json
const tauriConf = readJson('src-tauri/tauri.conf.json');
tauriConf.version = next;
writeJson('src-tauri/tauri.conf.json', tauriConf);

// 6. Commit + tag.
sh(`git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json`);
sh(`git commit -m "chore(release): v${next}"`, { stdio: 'inherit' });
sh(`git tag -a v${next} -m "TAMIAS v${next}"`, { stdio: 'inherit' });
process.stdout.write(`✓ Tagged v${next}\n`);

// 7. Optionally push.
if (noPush) {
  process.stdout.write('• Skipped push (--no-push). When ready: git push && git push --tags\n');
} else {
  sh(`git push`, { stdio: 'inherit' });
  sh(`git push --tags`, { stdio: 'inherit' });
  process.stdout.write(`✓ Pushed v${next}. The desktop release workflow will build installers.\n`);
}
