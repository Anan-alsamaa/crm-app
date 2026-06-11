import { defineConfig } from 'vite';

// Builds the embeddable widget as a single IIFE bundle exposing window.YijiChat.
// `pnpm dev` serves the demo host page (index.html) for local testing.
//
// We use esbuild's automatic JSX runtime for Preact rather than
// `@preact/preset-vite`: on Windows the preset `import()`s its dev
// JSX-transform plugin via an absolute path that Node's ESM resolver rejects,
// which crashes `vite` (both dev and build). esbuild transforms the JSX fine —
// the only trade-off is no prefresh component-state HMR (the page full-reloads
// on edit), which is acceptable for a small embeddable widget.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
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
});
