import { defineConfig, loadEnv, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../');

/*
 * The two customer PAGES: the chat (index.html -> host.ts) and the store QR
 * form (walk-in.html -> walk-in.ts).
 *
 * A second build, because the main one is Vite's library mode, which emits
 * the embeddable bundle and nothing else; library mode cannot also take HTML
 * entries. This one writes into the same dist/ without emptying it, so a
 * deploy publishes bundle and pages from one directory.
 *
 * What it must never do is publish a page that can mint a customer token.
 * The dev harness (demo.ts) signs one in the browser with the shared secret,
 * which is fine at localhost and catastrophic on a public URL: anyone could
 * mint a valid identity for ANY phone number and read that customer's chat.
 * host.ts only imports demo.ts inside a DEV-only branch, so the build drops
 * it; the plugin below is the proof rather than the hope, and fails the build
 * if the harness, the signing call, or the secret's value is found in
 * anything about to be written.
 */
function refuseSecrets(secrets: string[]): Plugin {
  const needles = ['SignJWT', 'dev-yiji-secret', ...secrets];
  return {
    name: 'widget-pages-refuse-secrets',
    apply: 'build',
    generateBundle(_, bundle) {
      for (const [name, out] of Object.entries(bundle)) {
        if (out.type === 'chunk') {
          const harness = Object.keys(out.modules).find((m) => /[\/]demo\.ts$/.test(m));
          if (harness)
            this.error(`${name}: the dev demo harness (${harness}) is in a published page`);
        }
        const text =
          out.type === 'chunk' ? out.code : typeof out.source === 'string' ? out.source : null;
        if (text === null) continue; // binary asset
        for (const needle of needles) {
          if (text.includes(needle)) {
            const what =
              needle === 'SignJWT' || needle === 'dev-yiji-secret'
                ? `"${needle}"`
                : 'the JWT signing secret';
            this.error(`${name} contains ${what}. Refusing to emit a page that could mint tokens.`);
          }
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Both env homes: the repo root (YIJI_JWT_SECRET) and this package
  // (.env.local, VITE_WIDGET_JWT_SECRET). The guard should know every secret
  // that could have been baked in.
  const env = {
    ...loadEnv(mode, repoRoot, ''),
    ...loadEnv(mode, here, ''),
    ...process.env,
  } as Record<string, string | undefined>;
  const secrets = [env.YIJI_JWT_SECRET, env.VITE_WIDGET_JWT_SECRET].filter(
    (s): s is string => typeof s === 'string' && s.length >= 8 && s !== 'undefined',
  );
  // The opt-in local QA harness (vite.config.ts) emits its own index.html,
  // with the in-browser mint. When it is on, leave index.html to it and build
  // only the QR page, or the two would fight over the file.
  const demoHostPage = env.WIDGET_DEMO_HOST_PAGE === 'true';

  return {
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    // The library build already copied public/ (the logo, serve.json).
    publicDir: false,
    plugins: [refuseSecrets(secrets)],
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      rollupOptions: {
        input: {
          ...(demoHostPage ? {} : { index: resolve(here, 'index.html') }),
          'walk-in': resolve(here, 'walk-in.html'),
        },
      },
    },
  };
});
