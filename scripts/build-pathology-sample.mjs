#!/usr/bin/env node
//
// Generate a small, public-domain synthetic H&E-style pathology sample
// for examples/pathology/. The image is procedurally produced (no real
// patient data, no third-party copyright) so it can ship inside the
// repo without worrying about CAMELYON16 / TCGA / PANDA terms.
//
// Output: examples/pathology/synthetic_he_2048.png  (~ 1024×1024,
// pinkish-purple H&E aesthetic with circular nuclei) plus a sidecar
// `synthetic_he_2048.json` describing the calibrated MPP so the
// distance ruler reads in microns.
//
// Run via:  node scripts/build-pathology-sample.mjs

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// CRC table needs to be ready BEFORE encodePng runs at script bottom
// (function declarations hoist but const-IIFEs don't, hence TDZ).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

const W = 512;
const H = 512;

// Simple seeded RNG so the output is reproducible.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0xa11ce5ee);

// 1) Background: pale pink stroma with subtle noise.
const rgb = new Uint8Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Cheap fBm-ish noise.
    const n =
      (Math.sin(x * 0.015) + Math.cos(y * 0.012) +
        Math.sin((x + y) * 0.008)) / 6 + 0.5;
    const wobble = (rand() - 0.5) * 0.06;
    const v = Math.max(0, Math.min(1, n + wobble));
    const i = (y * W + x) * 3;
    rgb[i] = Math.round(220 + 25 * v); // R — pinkish
    rgb[i + 1] = Math.round(180 + 30 * v); // G
    rgb[i + 2] = Math.round(205 + 25 * v); // B — slight purple cast
  }
}

// 2) Nuclei: dark purple discs scattered with cluster bias.
function paintDisc(cx, cy, r, dr, dg, db) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H, Math.ceil(cy + r));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r) {
        const t = 1 - d2 / (r * r); // soft edge
        const i = (y * W + x) * 3;
        rgb[i] = Math.max(0, Math.min(255, rgb[i] + dr * t));
        rgb[i + 1] = Math.max(0, Math.min(255, rgb[i + 1] + dg * t));
        rgb[i + 2] = Math.max(0, Math.min(255, rgb[i + 2] + db * t));
      }
    }
  }
}

// Cluster centres — gives the slide a "tissue island" feel.
const clusters = 6;
for (let c = 0; c < clusters; c++) {
  const cx = rand() * W;
  const cy = rand() * H;
  const n = 40 + Math.floor(rand() * 50);
  for (let i = 0; i < n; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = rand() * rand() * 60;
    const x = cx + Math.cos(angle) * dist;
    const y = cy + Math.sin(angle) * dist;
    const r = 3 + rand() * 4;
    paintDisc(x, y, r, -120, -100, -60);
  }
}

// Sparse stray nuclei everywhere.
for (let i = 0; i < 500; i++) {
  paintDisc(rand() * W, rand() * H, 2 + rand() * 3, -90, -80, -50);
}

// 3) Encode as PNG (truecolour, 8-bit). Hand-rolled because we don't
//    want to drag a dependency in for this build script.
const png = encodePng(W, H, rgb);

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'examples', 'pathology');
const outPng = join(outDir, 'synthetic_he_512.png');
writeFileSync(outPng, png);

// Sidecar declaring an MPP. We pick 0.5 µm/px (a 20× scan) so the
// distance ruler renders in plausible micrometres.
const sidecar = {
  description:
    'Procedurally-generated synthetic H&E patch (CC0). Nuclei are 2D ' +
    'discs; no real patient data. MPP is declared at 0.5 µm/px (20× ' +
    'scan equivalent) for the ruler.',
  mpp: 0.5,
  width: W,
  height: H,
  generator: 'scripts/build-pathology-sample.mjs',
  license: 'CC0-1.0',
};
writeFileSync(
  join(outDir, 'synthetic_he_512.json'),
  JSON.stringify(sidecar, null, 2) + '\n'
);

console.log(`wrote ${outPng}  (${(png.length / 1024).toFixed(1)} KiB)`);
console.log(`wrote ${join(outDir, 'synthetic_he_512.json')}`);

// ───────────────────────────────────────────────────────────────────
// Minimal PNG encoder (deflate via zlib, CRC32, IHDR/IDAT/IEND).
function encodePng(width, height, rgbBuf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Pre-filter: prepend a 0x00 (None) per scan-line.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(rgbBuf.buffer, rgbBuf.byteOffset, rgbBuf.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idatBody = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatBody),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0);
  return Buffer.concat([len, typeBuf, body, crc]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
