import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Config for the one-off data loaders in this directory.
 *
 * These are NOT tests. They are scripts that talk to a deployed environment
 * and write to it, and they live under Vitest only because it is the one
 * TypeScript runner available here — which lets them import the app's real
 * mapping functions instead of carrying a second copy that would drift.
 *
 * They are deliberately kept out of the ROOT config's `include`
 * (`{packages,services}/**`), so `pnpm verify` and CI never collect them: a
 * suite that logs into staging and inserts rows must never run unattended.
 * Point at this config explicitly to run one:
 *
 *   node node_modules/vitest/vitest.mjs run \
 *     --config scripts/one-off/vitest.config.ts \
 *     scripts/one-off/import-complaints-history.vitest.ts
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  /*
   * The root stays the REPO root. Pointing it at this directory would make the
   * `include` pattern read more naturally, but it also cuts the resolver off
   * from the workspace's node_modules, and the pnpm links to `@yiji/*` stop
   * resolving — so `include` is written repo-relative instead.
   */
  root: repoRoot,
  resolve: {
    // The workspace packages are TypeScript source with no build output, so
    // alias them straight at their entry points.
    alias: {
      '@yiji/reports': `${repoRoot}packages/reports/src/index.ts`,
      '@yiji/shared-types': `${repoRoot}packages/shared-types/src/index.ts`,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/one-off/**/*.vitest.ts'],
    // One at a time: these are network-bound writers, not parallel-safe.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // A full load is ~1,600 inserts over the public API.
    testTimeout: 1_800_000,
  },
});
