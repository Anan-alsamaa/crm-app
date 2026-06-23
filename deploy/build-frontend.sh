#!/usr/bin/env bash
#
# build-frontend.sh — build the static portals + embeddable widget for a Linux
# production deploy, from a SINGLE checkout of this repo (001 is self-contained;
# no sibling crm-app-frontend repo is needed).
#
#   bash deploy/build-frontend.sh
#
# Produces three static bundles that nginx serves (see deploy/nginx/yiji-crm.conf):
#   apps/agent-portal/dist   →  agent.DOMAIN
#   apps/admin-portal/dist   →  admin.DOMAIN
#   apps/chat-widget/dist    →  widget.DOMAIN   (embeddable JS/CSS only)
#
# VITE_* values are baked at build time. Export them (or source .env.prod) before
# running so the SPAs point at the public api./ws./ai. hostnames. Do NOT set the
# widget's demo JWT secret here — see the security note below.
#
# SECURITY: the widget's dev demo host page (index.html) signs a customer JWT in
# the browser. That is a LOCAL demo convenience only; if it were built with the
# real YIJI_JWT_SECRET and served publicly, anyone could mint customer tokens for
# any vendor. The platform/storefront embeds the widget script and mints the
# customer token SERVER-side, so this script deletes the demo host page from the
# widget bundle — the public widget host serves only the embeddable assets.
# (The Windows build-frontend.ps1 is a local-demo helper and must NOT be used for
# a public deploy: it injects the real secret into that host page.)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

echo "==> Building static frontends from $ROOT"
pnpm --filter @yiji/agent-portal build
pnpm --filter @yiji/admin-portal build
pnpm --filter @yiji/chat-widget build

# Strip the widget's dev demo host page from the production bundle: the public
# widget host must serve ONLY the embeddable assets (yiji-chat-widget.js,
# chat-widget.css, yiji-logo.png), never the in-browser JWT-mint demo page.
rm -f apps/chat-widget/dist/index.html apps/chat-widget/dist/serve.json

echo "==> Built:"
for app in agent-portal admin-portal chat-widget; do
  echo "      apps/$app/dist"
done
echo "==> Point nginx at these (symlink into the configured roots), e.g.:"
echo "      sudo ln -sfn \"$ROOT/apps/agent-portal/dist\" /srv/yiji/agent-portal/dist"
echo "      sudo ln -sfn \"$ROOT/apps/admin-portal/dist\" /srv/yiji/admin-portal/dist"
echo "      sudo ln -sfn \"$ROOT/apps/chat-widget/dist\"  /srv/yiji/chat-widget/dist"
echo "    then: sudo nginx -t && sudo systemctl reload nginx"
