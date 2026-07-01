/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

// Dedicated test config so the suite does not load `@preact/preset-vite`, whose
// dev JSX-transform plugin is `import()`ed via an absolute path that Node's ESM
// resolver rejects on Windows. esbuild handles the preact automatic runtime for
// any JSX tests; the build/dev pipeline still uses vite.config.ts unchanged.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    // Coverage is measured so the widget appears in `pnpm verify` and its gap is
    // visible. No thresholds yet: the widget has no unit suite, so gating here
    // would be a false red — the number itself (currently ~0%) is the signal.
    // Add thresholds once a suite exists (embed init, token identity, demo mint).
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/vite-env.d.ts', '**/*.d.ts'],
    },
  },
});
