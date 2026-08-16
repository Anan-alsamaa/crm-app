/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  build: {
    rollupOptions: {
      onwarn(w: { code?: string; message: string }, warn: (w: unknown) => void) {
        if (w.code === 'CIRCULAR_DEPENDENCY') console.log('CYCLE >>', w.message);
        warn(w);
      },
      output: {
        /*
         * Every third-party dependency in ONE chunk.
         *
         * Rollup's default splitting put zod in a chunk that a route chunk
         * depended on while zod's own chunk depended back — a cycle that is
         * harmless in dev (native ESM resolves it) and fatal in the build,
         * where the generated initialisation order threw "Cannot access 'z'
         * before initialization". The tickets report caught it: twenty
         * successful requests and a permanent skeleton, because the failure
         * was in module initialisation rather than in any of them.
         *
         * A single vendor chunk cannot form a cycle with itself. It costs a
         * larger first download and buys back a class of bug that only ever
         * appears in production.
         */
        manualChunks(id: string) {
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
  },
});
