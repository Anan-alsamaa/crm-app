/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// Builds the embeddable widget as a single IIFE bundle exposing window.YijiChat.
// `pnpm dev` serves the demo host page (index.html) for local testing.
export default defineConfig({
  plugins: [preact()],
  server: { port: 5175 },
  build: {
    lib: {
      entry: 'src/embed.ts',
      name: 'YijiChat',
      formats: ['iife'],
      fileName: () => 'yiji-chat-widget.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
  },
});
