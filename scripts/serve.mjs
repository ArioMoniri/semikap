#!/usr/bin/env node
/**
 * Production static server for TAMIAS.
 *
 * - Serves the prebuilt `dist/` directory.
 * - Sets the COOP/COEP headers required for SharedArrayBuffer (multi-threaded
 *   WASM in onnxruntime-web).
 * - Picks a default port (5180); if it's already in use, walks upward to the
 *   next free one and prints the chosen port to stdout.
 * - SPA fallback: any path that doesn't match a file falls back to index.html.
 *
 * Usage:
 *   node scripts/serve.mjs                # PORT=5180, HOST=0.0.0.0
 *   PORT=8080 HOST=127.0.0.1 node scripts/serve.mjs
 *
 * The chosen port is printed as the literal line:
 *   TAMIAS_PORT=<port>
 * to make it parseable from process supervisors (systemd, pm2, Docker logs).
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT = resolve(__dirname, '..', 'dist');

const HOST = process.env.HOST ?? '0.0.0.0';
const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? '5180', 10);
const MAX_PORT_PROBES = 50;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function setBaseHeaders(res) {
  // Required to enable SharedArrayBuffer / multi-threaded WASM.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Sensible defaults; the in-page CSP is the authoritative one.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'interest-cohort=()');
}

async function tryServe(filePath, res) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const ext = extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', s.size);
    if (ext === '.wasm' || ext === '.js' || ext === '.css') {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (ext === '.html' || ext === '.webmanifest') {
      res.setHeader('Cache-Control', 'no-cache');
    }
    res.end(await readFile(filePath));
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  setBaseHeaders(res);

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  // Defend against path traversal: resolve and require the result to start
  // with the dist root + separator.
  const requested = decodeURIComponent(url.pathname);
  const safe = normalize(requested).replace(/^[\\/]+/, '');
  const candidate = resolve(ROOT, safe);
  if (!candidate.startsWith(ROOT + sep) && candidate !== ROOT) {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

  // Try the exact file, then index.html for directories, then SPA fallback.
  if (await tryServe(candidate, res)) return;
  if (await tryServe(join(candidate, 'index.html'), res)) return;
  if (await tryServe(join(ROOT, 'index.html'), res)) return;

  res.statusCode = 404;
  res.end('Not found');
});

function listenOn(port, attempts) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' && attempts > 0) {
        const next = port + 1;
        process.stderr.write(`port ${port} in use, trying ${next}…\n`);
        listenOn(next, attempts - 1).then(resolveListen, rejectListen);
      } else {
        rejectListen(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolveListen(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

(async () => {
  try {
    await stat(join(ROOT, 'index.html'));
  } catch {
    process.stderr.write(
      `error: dist/index.html not found at ${ROOT}\n` +
        `       run "npm run build" before "npm start".\n`
    );
    process.exit(2);
  }

  try {
    const port = await listenOn(DEFAULT_PORT, MAX_PORT_PROBES);
    const host = HOST === '0.0.0.0' ? 'localhost' : HOST;
    process.stdout.write(`TAMIAS_PORT=${port}\n`);
    process.stdout.write(`Serving dist/ on http://${host}:${port}\n`);
    process.stdout.write(`(bind: ${HOST}:${port}, COOP/COEP enabled)\n`);
  } catch (err) {
    process.stderr.write(
      `error: could not bind any port in [${DEFAULT_PORT}, ${DEFAULT_PORT + MAX_PORT_PROBES}]: ${err.message}\n`
    );
    process.exit(1);
  }
})();

const shutdown = (sig) => () => {
  process.stderr.write(`\nreceived ${sig}, shutting down\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
