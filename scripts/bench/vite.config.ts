// vite-node config for the headless benchmark runner: swaps onnxruntime-web
// for onnxruntime-node (native CPU, multithreaded). Set ORT_NODE to the
// onnxruntime-node package directory.
import { defineConfig } from 'vite';

const ortNode = process.env.ORT_NODE;
if (!ortNode) throw new Error('Set ORT_NODE=/path/to/node_modules/onnxruntime-node');

export default defineConfig({
  resolve: { alias: { 'onnxruntime-web': ortNode } },
  server: { deps: { external: [/onnxruntime-node/] } },
});
