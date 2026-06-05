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
    // A single forked worker keeps peak memory low (the socket-gateway suite
    // spins real Socket.IO servers) so coverage runs are stable on constrained
    // runners. The whole services+packages suite is only a few seconds.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
      include: ['services/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: [
        '**/dist/**',
        '**/*.config.*',
        '**/tests/**',
        '**/*.d.ts',
        // Server/worker bootstrap entrypoints: import-time side effects + process
        // wiring, exercised by E2E rather than unit tests. Excluded from the
        // coverage denominator so the service targets reflect testable logic.
        'services/*/src/index.ts',
        'services/workers/src/processors/index.ts',
      ],
      // Per-service line targets (spec: 70% across services). Packages are not
      // gated here (packages/ui is Stream B's surface); shared-types is already
      // ~98% via its own suite.
      thresholds: {
        'services/socket-gateway/src/**': { lines: 70, statements: 70 },
        'services/workers/src/**': { lines: 70, statements: 70 },
        'services/ai-gateway/src/**': { lines: 70, statements: 70 },
      },
    },
  },
});
