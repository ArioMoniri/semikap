import { describe, expect, it } from 'vitest';
import { captureEnv, describeEnv } from '../src/lib/benchmark/env';
import type { BackendInfo } from '../src/types';

describe('captureEnv', () => {
  it('maps a full BackendInfo to every ReproEnv field', () => {
    const backend: BackendInfo = {
      provider: 'webgpu',
      adapter: {
        vendor: 'apple',
        architecture: 'metal-3',
        device: 'Apple M2',
        description: 'Apple M2 GPU',
      },
      wasmThreads: 8,
      crossOriginIsolated: true,
    };
    const env = captureEnv(backend, '1.2.3');
    expect(env.provider).toBe('webgpu');
    expect(env.adapterVendor).toBe('apple');
    expect(env.adapterArchitecture).toBe('metal-3');
    expect(env.wasmThreads).toBe(8);
    expect(env.crossOriginIsolated).toBe(true);
    expect(env.appVersion).toBe('1.2.3');
    // userAgent mirrors globalThis.navigator?.userAgent: present or omitted,
    // never invented. Modern Node exposes it; older runtimes do not.
    const ua = globalThis.navigator?.userAgent;
    if (ua === undefined) {
      expect('userAgent' in env).toBe(false);
    } else {
      expect(env.userAgent).toBe(ua);
    }
  });

  it('defaults provider to wasm for a null backend and omits adapter fields', () => {
    const env = captureEnv(null, '0.10.16');
    expect(env.provider).toBe('wasm');
    expect(env.appVersion).toBe('0.10.16');
    expect('adapterVendor' in env).toBe(false);
    expect('adapterArchitecture' in env).toBe(false);
    expect('wasmThreads' in env).toBe(false);
    expect('crossOriginIsolated' in env).toBe(false);
  });

  it('omits adapter fields when a wasm backend has no adapter', () => {
    const backend: BackendInfo = {
      provider: 'wasm',
      wasmThreads: 4,
      crossOriginIsolated: false,
    };
    const env = captureEnv(backend, '1.0.0');
    expect(env.provider).toBe('wasm');
    expect('adapterVendor' in env).toBe(false);
    expect('adapterArchitecture' in env).toBe(false);
    expect(env.wasmThreads).toBe(4);
    // false is defined, so it is kept.
    expect(env.crossOriginIsolated).toBe(false);
    expect('crossOriginIsolated' in env).toBe(true);
  });
});

describe('describeEnv', () => {
  it('renders provider, adapter, and COI joined by middot', () => {
    const env = captureEnv(
      {
        provider: 'webgpu',
        adapter: { vendor: 'apple', architecture: 'metal-3', device: 'd', description: 'x' },
        crossOriginIsolated: true,
      },
      '1.0.0',
    );
    expect(describeEnv(env)).toBe('webgpu · apple metal-3 · COI');
  });

  it('drops the COI segment when not cross-origin isolated', () => {
    const env = captureEnv(
      {
        provider: 'webgpu',
        adapter: { vendor: 'nvidia', architecture: 'ampere', device: 'd', description: 'x' },
        crossOriginIsolated: false,
      },
      '1.0.0',
    );
    expect(describeEnv(env)).toBe('webgpu · nvidia ampere');
  });

  it('shows only the provider when there is no adapter', () => {
    expect(describeEnv({ provider: 'wasm', appVersion: '1.0.0' })).toBe('wasm');
  });

  it('shows COI right after the provider when the adapter is absent', () => {
    expect(
      describeEnv({ provider: 'wasm', crossOriginIsolated: true, appVersion: '1.0.0' }),
    ).toBe('wasm · COI');
  });

  it('renders a lone adapter part when architecture is absent', () => {
    expect(
      describeEnv({ provider: 'webgpu', adapterVendor: 'apple', appVersion: '1.0.0' }),
    ).toBe('webgpu · apple');
  });
});
