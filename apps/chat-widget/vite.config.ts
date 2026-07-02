import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../');

// Builds the embeddable widget as a single IIFE bundle exposing window.YijiChat.
// `pnpm dev` serves the demo host page (index.html) for local testing.
//
// We use esbuild's automatic JSX runtime for Preact rather than
// `@preact/preset-vite`: on Windows the preset `import()`s its dev
// JSX-transform plugin via an absolute path that Node's ESM resolver rejects,
// which crashes `vite` (both dev and build). esbuild transforms the JSX fine —
// the only trade-off is no prefresh component-state HMR (the page full-reloads
// on edit), which is acceptable for a small embeddable widget.

/**
 * Library mode emits only the JS/CSS bundle — never an index.html. But the
 * local prod-like stack serves `dist/` statically and needs a host page at
 * :5175, or the static server just lists the directory. This plugin generates
 * that host page on every build from the SAME landing-page markup the dev
 * server uses (index.html), swapping the dev-only `/src/demo.ts` script for the
 * real bundle plus an inline token-mint. Because it regenerates each build, the
 * page can never silently vanish after a rebuild again.
 *
 * The inline mint is the prod-like equivalent of demo.ts: a real host page
 * receives a platform-signed JWT, but the local :5175 harness has no platform,
 * so it signs one in-browser with the shared dev secret (matching the gateway's
 * YIJI_JWT_SECRET) so the widget authenticates end-to-end. DEV/QA ONLY.
 */
function widgetHostPage(secret: string, gatewayUrl: string): Plugin {
  return {
    name: 'widget-host-page',
    apply: 'build',
    generateBundle() {
      const template = readFileSync(resolve(here, 'index.html'), 'utf8');
      const init = `
    <link rel="stylesheet" href="/chat-widget.css" />
    <script src="/yiji-chat-widget.js"></script>
    <script>
      // DEV/QA host page — mints a local JWT so the widget connects end-to-end.
      // A real host page receives this token from the Yiji platform instead.
      (function () {
        var GATEWAY = ${JSON.stringify(gatewayUrl)};
        var SECRET = ${JSON.stringify(secret)};
        var DEFAULTS = {
          vendor_id: 'demo-vendor',
          customer_id: 'demo-customer-1',
          phone: '+966500000001',
          email: 'demo.customer@example.com',
          name: 'Demo Customer',
        };
        function identity() {
          var q = new URL(location.href).searchParams;
          var phone = q.get('phone') || DEFAULTS.phone;
          // customer_id is REQUIRED by the gateway. The Yiji app should pass the
          // real customer id (?customer_id=...); when only a phone is supplied,
          // derive a stable per-phone id so each customer is distinct (and so a
          // customer_id is always present for order lookups).
          var customerId = q.get('customer_id') || (phone ? 'cust-' + phone.replace(/\\D/g, '') : DEFAULTS.customer_id);
          return {
            vendor_id: q.get('vendor_id') || DEFAULTS.vendor_id,
            customer_id: customerId,
            phone: phone,
            email: q.get('email') || DEFAULTS.email,
            name: q.get('name') || DEFAULTS.name,
          };
        }
        function b64u(bytes) {
          var s = '', b = new Uint8Array(bytes);
          for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
          return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        }
        function b64uStr(str) { return b64u(new TextEncoder().encode(str)); }
        async function mint(id) {
          var header = b64uStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
          var now = Math.floor(Date.now() / 1000);
          // 12h TTL: a local QA harness shouldn't lose its session every 2h.
          // (A real host page receives a platform-signed token instead.)
          var payload = b64uStr(JSON.stringify(Object.assign({}, id, { iat: now, exp: now + 43200 })));
          var data = header + '.' + payload;
          var key = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
          );
          var sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
          return data + '.' + b64u(sig);
        }
        mint(identity()).then(function (token) {
          // autoOpen: this is a dedicated support page — land straight in the chat.
          window.YijiChat.init({ gatewayUrl: GATEWAY, token: token, locale: 'en', autoOpen: true });
        });
      })();
    </script>`;
      const html = template.replace(
        /\s*<script type="module" src="\/src\/demo\.ts"><\/script>/,
        init,
      );
      this.emitFile({ type: 'asset', fileName: 'index.html', source: html });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load env from the monorepo root (where the shared .env lives) without the
  // VITE_ prefix filter, so we can read the gateway's JWT secret for the mint.
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env } as Record<string, string>;
  const secret =
    env.YIJI_JWT_SECRET ||
    (env.VITE_WIDGET_JWT_SECRET && env.VITE_WIDGET_JWT_SECRET !== 'undefined'
      ? env.VITE_WIDGET_JWT_SECRET
      : 'dev-yiji-secret');
  const gatewayUrl = env.VITE_SOCKET_URL || 'http://localhost:8080';

  return {
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
    },
    server: {
      port: 5175,
      // Expose to ngrok/LAN. allowedHosts lets vite accept the ngrok Host header
      // (vite 6 blocks unknown hosts otherwise → "Blocked request"). The proxy
      // forwards the widget's socket — which connects to the SAME public origin
      // (VITE_SOCKET_URL) — to the local gateway, incl. the WebSocket upgrade.
      host: true,
      allowedHosts: true,
      proxy: {
        '/socket.io': { target: 'http://localhost:8080', ws: true, changeOrigin: true },
      },
    },
    plugins: [widgetHostPage(secret, gatewayUrl)],
    build: {
      lib: {
        entry: 'src/embed.ts',
        name: 'YijiChat',
        formats: ['iife'],
        fileName: () => 'yiji-chat-widget.js',
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  };
});
