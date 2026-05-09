// ONNX Runtime Web session wrappers for the SAM encoder + decoder.
//
// These mirror the regular inference path's createSession() (src/lib/inference/ort.ts)
// but split into two specialised helpers so the worker can keep the
// expensive encoder session alive while it runs the cheap decoder
// repeatedly per prompt revision.

import * as ort from 'onnxruntime-web';
import { configureOrt, type Provider } from '../inference/ort';
import type { Bytes } from '../../types';
import type { SamPrompt } from './types';

export interface SamEncoderSession {
  session: ort.InferenceSession;
  inputName: string;
  outputName: string;
  provider: Provider;
}

export interface SamDecoderSession {
  session: ort.InferenceSession;
  /** Names of every input the decoder expects, in the order it expects.
   *  We discover these at session creation so the worker doesn't need to
   *  hardcode HuggingFace's naming convention (which has shifted between
   *  SAM 1 / SAM 2 / SAM 3 exports). */
  inputs: ReadonlyArray<string>;
  outputs: ReadonlyArray<string>;
  provider: Provider;
}

const FALLBACK_CHAIN: Provider[] = ['webgpu', 'webnn', 'wasm'];

async function tryProvider(
  bytes: Bytes,
  provider: Provider
): Promise<ort.InferenceSession | null> {
  try {
    return await ort.InferenceSession.create(bytes, {
      executionProviders: [provider],
      graphOptimizationLevel: 'all',
    });
  } catch (err) {
    console.warn(`[SAM] EP "${provider}" unavailable:`, err);
    return null;
  }
}

async function createWithFallback(bytes: Bytes, preferred: Provider | 'auto'): Promise<{
  session: ort.InferenceSession;
  provider: Provider;
}> {
  configureOrt();
  const chain: Provider[] =
    preferred === 'auto' || !FALLBACK_CHAIN.includes(preferred)
      ? FALLBACK_CHAIN
      : [preferred, ...FALLBACK_CHAIN.filter((p) => p !== preferred)];
  for (const provider of chain) {
    const session = await tryProvider(bytes, provider);
    if (session) return { session, provider };
  }
  throw new Error(`Failed to create SAM session on any provider (tried ${chain.join(', ')}).`);
}

export async function createSamEncoderSession(
  encoderBytes: Bytes,
  preferred: Provider | 'auto' = 'webgpu'
): Promise<SamEncoderSession> {
  const { session, provider } = await createWithFallback(encoderBytes, preferred);
  return {
    session,
    provider,
    inputName: session.inputNames[0]!,
    outputName: session.outputNames[0]!,
  };
}

export async function createSamDecoderSession(
  decoderBytes: Bytes,
  preferred: Provider | 'auto' = 'webgpu'
): Promise<SamDecoderSession> {
  const { session, provider } = await createWithFallback(decoderBytes, preferred);
  return {
    session,
    provider,
    inputs: [...session.inputNames],
    outputs: [...session.outputNames],
  };
}

/**
 * Pack a list of prompts into the (point_coords, point_labels) tensors
 * the SAM decoder expects.
 *
 * SAM's decoder expects:
 *   - point_coords: float32 [1, N, 2]  — (x, y) in 1024² space
 *   - point_labels: float32 [1, N]      — 1=positive, 0=negative,
 *                                          2=box top-left, 3=box bot-right,
 *                                          -1=padding (unused slot)
 *
 * Each box prompt expands to TWO point entries (top-left=2, bot-right=3).
 * Text prompts are NOT packed here — they require a separate text encoder
 * pass which only SAM 3 ships, and we wire that in once a stable export
 * lands. The worker filters them out before calling this.
 *
 * The prompts array passes coords already mapped to 1024² space (the
 * caller did this with sourceToSamCoords()).
 */
export function packSamPointPrompts(
  prompts: SamPrompt[]
): { coords: Float32Array; labels: Float32Array; n: number } {
  // Count entries — each point = 1, each box = 2, text = 0.
  let n = 0;
  for (const p of prompts) {
    if (p.kind === 'point') n++;
    else if (p.kind === 'box') n += 2;
  }
  // SAM expects at least one entry; if the caller had only text prompts
  // we'd still need to emit a padding entry. The worker handles the
  // empty-prompts case earlier, but be defensive.
  if (n === 0) n = 1;

  const coords = new Float32Array(n * 2);
  const labels = new Float32Array(n);
  let off = 0;
  for (const p of prompts) {
    if (p.kind === 'point') {
      coords[off * 2 + 0] = p.xy[0];
      coords[off * 2 + 1] = p.xy[1];
      labels[off] = p.label === 1 ? 1 : 0;
      off++;
    } else if (p.kind === 'box') {
      // Top-left.
      coords[off * 2 + 0] = p.xyxy[0];
      coords[off * 2 + 1] = p.xyxy[1];
      labels[off] = 2;
      off++;
      // Bottom-right.
      coords[off * 2 + 0] = p.xyxy[2];
      coords[off * 2 + 1] = p.xyxy[3];
      labels[off] = 3;
      off++;
    }
  }
  // If we padded (no real prompts), label the padding slot as -1 so the
  // decoder ignores it.
  if (off === 0) labels[0] = -1;
  return { coords, labels, n };
}
