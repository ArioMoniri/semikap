/**
 * Vitest configuration. v0.7.4 introduces the test runner so we can
 * lock down the public surface of the new on-prem AI loaders before
 * they grow inference runtimes. Same module-resolution as Vite (the
 * build config is symmetric so .tsx imports resolve identically) plus
 * a tightened includeSource pattern so unit tests live under tests/
 * and don't accidentally spawn a dev server.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/lib/totalseg/**/*.ts', 'src/lib/sam/**/*.ts'],
    },
  },
});
