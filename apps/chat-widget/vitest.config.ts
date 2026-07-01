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
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    // Coverage is enforced (suite covers socket, embed, demo, i18n, and the
    // Widget component). Thresholds sit below the current numbers (~78% lines /
    // 82% branches / 65% funcs) with headroom so honest churn doesn't red the
    // gate, while blocking regressions.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/vite-env.d.ts', '**/*.d.ts'],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 60,
        branches: 75,
      },
    },
  },
});
