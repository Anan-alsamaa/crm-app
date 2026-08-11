/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Quality-stream test config (owned by Stream C). Self-contained (does not
 * import vite.config to avoid an esbuild config-bundling crash on Windows):
 * mirrors the app's jsdom + react-plugin test setup and layers coverage on top.
 *
 * Excluded from the denominator: bootstrap (main.tsx), generated/typing files,
 * and i18n resource loaders — none are meaningful to unit-test.
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
    /* WINDOWS: react-i18next's ESM build imports `html-parse-stringify`, which
     * ships no `exports` map. Left external, Vite hands Node a bare WINDOWS
     * path (`D:\...\html-parse-stringify.js`); Node's ESM loader only accepts
     * forward slashes or a file:// URL for an absolute specifier, so it reads
     * the backslash path as a PACKAGE NAME and fails with "Cannot find package
     * 'D:\...'". Every suite that renders a translated component dies at import
     * time — before a single assertion runs.
     *
     * Inlining it makes Vite resolve the import itself, which sidesteps the
     * path entirely. It stayed hidden because CI is Linux (forward slashes) and
     * a dev machine that has run `pnpm dev` has a warm .vite/deps cache that
     * serves the pre-bundled copy — so it reproduces only on a FRESH Windows
     * checkout, which is exactly what a new git worktree is. */
    server: { deps: { inline: [/react-i18next/] } },
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
