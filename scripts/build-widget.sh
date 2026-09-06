#!/usr/bin/env bash
# Build the widget host for one environment: the embeddable bundle plus the
# two customer pages (the chat and the store-QR form).
#
#   scripts/build-widget.sh staging
#
# The pages live on a static bucket and talk to the gateway on the API host,
# so that host is BAKED IN here (VITE_SOCKET_URL for the socket,
# VITE_GATEWAY_HTTP_URL for the QR page's session request). Left blank, a
# published page would talk to its own origin, which serves files and nothing
# else, and the chat would sit at "connecting" for ever.
#
# The API host comes from the same table the portals use
# (scripts/gen-portal-config.sh), so the widget can never be built against
# one environment's gateway and published to another's bucket.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  staging|prod) ;;
  *) echo "usage: $0 <staging|prod>" >&2; exit 2 ;;
esac

CONFIG="$(mktemp -t portal-config.XXXXXX.js)"
trap 'rm -f "$CONFIG"' EXIT
scripts/gen-portal-config.sh "$ENV_NAME" "$CONFIG" >/dev/null
API="$(sed -n "s/.*SOCKET_URL: '\([^']*\)'.*/\1/p" "$CONFIG")"
[ -n "$API" ] || { echo "FAIL: could not read SOCKET_URL for $ENV_NAME from gen-portal-config.sh" >&2; exit 1; }

# The local QA harness inlines the signing secret into index.html. A deploy
# build must never see it set, whatever the shell inherited.
unset WIDGET_DEMO_HOST_PAGE

printf '\n\033[1m==> widget for %s, gateway %s\033[0m\n' "$ENV_NAME" "$API"
VITE_SOCKET_URL="$API" VITE_GATEWAY_HTTP_URL="$API" pnpm --filter @yiji/chat-widget build
echo "built apps/chat-widget/dist; publish with scripts/deploy-portals.sh $ENV_NAME widget"
