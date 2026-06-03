import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. Runs unit/integration tests across all workspace
 * packages and services. Each app/service may add its own vitest.config.ts
 * (e.g. jsdom environment for React) which overrides this for its directory.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    // Apps run their own jsdom-based Vitest config via `pnpm -r test`.
    include: ['{packages,services}/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/**', '**/tests/e2e/**', '**/*.e2e.*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/*.config.*', '**/tests/**'],
    },
  },
});
