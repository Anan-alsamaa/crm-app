import { defineConfig } from 'vitest/config';

// Package-level config: the root config only collects packages/ and services/,
// so `pnpm -r test` runs this suite from here. Pure unit tests, no network.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
