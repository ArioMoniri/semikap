// Global ambient declarations for browser APIs that ship in the platform but
// are not yet (or only partially) covered by TypeScript's lib.dom.

/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/client" />

export {};

declare global {
  /** App version, injected at build time from package.json. */
  const __APP_VERSION__: string;

  interface ShowOpenFilePickerOptions {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }

  interface ShowSaveFilePickerOptions {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }

  interface Window {
    showOpenFilePicker(options?: ShowOpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(options?: ShowSaveFilePickerOptions): Promise<FileSystemFileHandle>;
  }

  interface GPUAdapterInfoLike {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
  }

  interface GPUAdapter {
    /** Modern WebGPU exposes adapter info as a getter. */
    readonly info?: GPUAdapterInfoLike;
    /** Legacy async accessor; still present in some implementations. */
    requestAdapterInfo?(): Promise<GPUAdapterInfoLike>;
  }
}
