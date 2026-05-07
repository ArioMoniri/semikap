import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

// COOP/COEP headers are required for SharedArrayBuffer (multi-threaded WASM in
// onnxruntime-web). They're set during dev/preview here. For static hosting
// (e.g. GitHub Pages) we additionally ship coi-serviceworker as a fallback so
// the app can self-promote to a cross-origin-isolated context.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      strategies: 'generateSW',
      includeAssets: ['favicon.svg', 'coi-serviceworker.min.js'],
      manifest: {
        name: 'TAMIAS — Transparent locAl Medical Image AnalysiS',
        short_name: 'TAMIAS',
        description:
          'Browser-only medical image analysis. Runs ONNX models on local DICOM/NIfTI files via WebGPU. No upload.',
        theme_color: '#0b1d3a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm,onnx,json,webmanifest}'],
        maximumFileSizeToCacheInBytes: 64 * 1024 * 1024,
        navigateFallback: 'index.html',
        // Keep ORT WASM/JSEP and large assets cacheable for offline use.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-cache',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    headers: crossOriginIsolationHeaders,
    fs: { strict: true },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // ORT ships its own WASM/glue; pre-bundling breaks the worker imports.
    exclude: ['onnxruntime-web'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          niivue: ['@niivue/niivue'],
          ort: ['onnxruntime-web'],
        },
      },
    },
  },
});
