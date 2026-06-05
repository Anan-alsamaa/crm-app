/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Quality-stream test config (owned by Stream C). Self-contained (does not
 * import vite.config to avoid an esbuild config-bundling crash on Windows):
 * mirrors the app's jsdom + react-plugin test setup and layers coverage on top.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
    // jsdom + React + esbuild are memory-hungry; a single forked worker keeps
    // peak RSS low so the suite is stable on constrained runners.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts', 'src/i18n/**', '**/*.d.ts'],
      thresholds: {
        lines: 60,
        functions: 55,
        statements: 60,
        branches: 70,
      },
    },
  },
});
