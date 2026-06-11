# build-frontend.ps1 — build the static portals + widget for the prod-like run.
#
#   pwsh ./build-frontend.ps1
#
# Builds agent-portal, admin-portal, chat-widget from crm-app-frontend with the
# VITE_* baked from crm-app-frontend/.env (root, gitignored), then regenerates
# the widget host page (dist/index.html) — the lib build doesn't emit one — using
# the original landing markup + the built IIFE bundle + a JWT minted with
# YIJI_JWT_SECRET from .env.prod. `serve` picks up new files automatically.
$ErrorActionPreference = 'Stop'
$infra = $PSScriptRoot
$fe = Join-Path (Split-Path $infra -Parent) 'crm-app-frontend'
$widget = Join-Path $fe 'apps\chat-widget'

$env:NODE_OPTIONS = '--max-old-space-size=4096'
Push-Location $fe
try {
  pnpm --filter @yiji/agent-portal build
  pnpm --filter @yiji/admin-portal build
  pnpm --filter @yiji/chat-widget build
} finally { Pop-Location }

# Regenerate the widget host page from the original landing page.
$secret = (Get-Content (Join-Path $infra '.env.prod') | Where-Object { $_ -like 'YIJI_JWT_SECRET=*' }).Split('=', 2)[1]
$html = Get-Content (Join-Path $widget 'index.html') -Raw
$html = $html -replace '</head>', "    <link rel=""stylesheet"" href=""/chat-widget.css"" />`r`n  </head>"
$mint = @"
<script src="/yiji-chat-widget.js"></script>
    <script>
      (function () {
        const SECRET = $($secret | ConvertTo-Json);
        const GATEWAY = 'http://localhost:8080';
        const q = new URL(location.href).searchParams, g = (k) => q.get(k) || undefined;
        const identity = { vendor_id: g('vendor_id') || 'demo-vendor', customer_id: g('customer_id') || 'demo-customer-1', phone: g('phone') || '+966500000001', email: g('email') || 'demo.customer@example.com', name: g('name') || 'Demo Customer' };
        const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const s64 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        (async () => {
          const now = Math.floor(Date.now() / 1000);
          const data = s64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + s64(JSON.stringify({ ...identity, iat: now, exp: now + 7200 }));
          const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
          window.YijiChat.init({ gatewayUrl: GATEWAY, token: data + '.' + b64u(sig), locale: 'en' });
        })();
      })();
    </script>
"@
$html = $html -replace '<script type="module" src="/src/demo\.ts"></script>', $mint
Set-Content -Path (Join-Path $widget 'dist\index.html') -Value $html -Encoding utf8
Write-Host 'Built agent-portal, admin-portal, chat-widget + regenerated widget host page.'
