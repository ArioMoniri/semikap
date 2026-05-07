#!/bin/sh
# TAMIAS one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ArioMoniri/semikap/main/install.sh | sh
#
# What it does:
#   1. Clones (or updates) the repo into ./tamias  (override with TAMIAS_DIR=…)
#   2. Installs Node deps with npm ci
#   3. Builds the production bundle (npm run build)
#   4. Starts the static server (npm start) which prints TAMIAS_PORT=<n>
#
# All steps are idempotent. Re-running the script updates an existing checkout
# and reuses the already-installed dependencies when nothing changed.
#
# Environment overrides:
#   TAMIAS_DIR   target directory for the clone (default: tamias)
#   TAMIAS_REPO  git URL to clone from         (default: https://github.com/ArioMoniri/semikap.git)
#   TAMIAS_REF   branch / tag / commit         (default: main)
#   PORT         port to bind                  (default: 5180; auto-shifts if busy)
#   HOST         interface to bind             (default: 0.0.0.0)

set -eu

TARGET_DIR="${TAMIAS_DIR:-tamias}"
REPO="${TAMIAS_REPO:-https://github.com/ArioMoniri/semikap.git}"
REF="${TAMIAS_REF:-main}"

cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" 1>&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || {
    red "✗ Required tool not on PATH: $1"
    red "  Install it and re-run."
    exit 1
  }
}

cyan "▶ Checking prerequisites…"
require git
require node
require npm

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "✗ Node $NODE_MAJOR detected; TAMIAS needs Node 20 or newer."
  exit 1
fi
green "✓ git, Node $NODE_MAJOR, npm present"

if [ ! -d "$TARGET_DIR/.git" ]; then
  cyan "▶ Cloning $REPO into $TARGET_DIR…"
  git clone --depth 1 --branch "$REF" "$REPO" "$TARGET_DIR"
else
  cyan "▶ Updating existing $TARGET_DIR…"
  git -C "$TARGET_DIR" fetch --depth 1 origin "$REF"
  git -C "$TARGET_DIR" checkout "$REF"
  git -C "$TARGET_DIR" pull --ff-only
fi
green "✓ Checkout ready at $TARGET_DIR"

cd "$TARGET_DIR"

cyan "▶ Installing Node dependencies (npm ci)…"
npm ci --no-audit --no-fund
green "✓ Dependencies installed"

cyan "▶ Building production bundle…"
npm run build
green "✓ Build complete"

cyan "▶ Starting TAMIAS server…"
green "  When you see TAMIAS_PORT=<n>, point your reverse proxy / domain at that port."
green "  Stop with Ctrl-C."
exec npm start
