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
  },
});
