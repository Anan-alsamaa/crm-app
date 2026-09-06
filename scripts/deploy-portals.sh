#!/usr/bin/env bash
#
# deploy-portals.sh — publish the built portals to S3 + CloudFront.
#
#   scripts/deploy-portals.sh staging            # both portals + the widget
#   scripts/deploy-portals.sh staging admin      # just one
#   scripts/deploy-portals.sh staging widget     # the embeddable widget only
#
# The manual equivalent has one trap that has already bitten once, which is the
# reason this file exists:
#
#   aws s3 sync dist/ s3://<bucket>/ --delete
#
# `--delete` REMOVES config.js from the bucket, because it is generated at
# deploy time and is not in dist/. The portal then falls back to the bundle's
# placeholder, which resolves the API to `<portal-origin>/directus` — a path
# nothing serves. Every request fails while the page itself loads perfectly, so
# it reads as "login is broken" rather than as a missing config file.
#
# Here the sync EXCLUDES config.js and the generated one is uploaded after, with
# no-cache, exactly as .github/workflows/deploy-ecs.yml already does. Use this
# instead of a bare sync for any manual deploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Fail loudly and stop. Used by the widget block below, where continuing after
# a missing bundle would publish an empty directory over a working one.
die() { printf '[31mFAIL: %s[0m
' "$*" >&2; exit 1; }

ENV_NAME="${1:-}"
ONLY="${2:-}"

case "$ENV_NAME" in
  staging|prod) ;;
  *) echo "usage: $0 <staging|prod> [agent|admin|widget]" >&2; exit 2 ;;
esac

# CloudFront distribution per bucket. Kept beside the bucket names so a deploy
# can never sync one environment and invalidate another.
case "$ENV_NAME" in
  staging)
    AGENT_DIST=E24IIVRFOW7GH4
    ADMIN_DIST=E1VN06BCLZ6Q4F
    WIDGET_DIST=E2QVORODPLQHNB
    ;;
  prod)
    AGENT_DIST=E3UK8T8DHFGMNW
    ADMIN_DIST=E37XKA7D2IPZLC
    # No production widget host yet — created per environment, like the portal
    # buckets. `deploy-portals.sh prod widget` fails loudly here rather than
    # silently publishing the widget to staging's distribution.
    WIDGET_DIST=""
    ;;
esac

CONFIG="$(mktemp -t portal-config.XXXXXX.js)"
trap 'rm -f "$CONFIG"' EXIT
scripts/gen-portal-config.sh "$ENV_NAME" "$CONFIG" >/dev/null

for app in agent admin; do
  [ "$ONLY" = "widget" ] && continue
  [ -n "$ONLY" ] && [ "$ONLY" != "$app" ] && continue

  BUCKET="crm-${ENV_NAME}-${app}-portal"
  DIST_VAR="$(echo "$app" | tr '[:lower:]' '[:upper:]')_DIST"
  DIST="${!DIST_VAR}"
  SRC="apps/${app}-portal/dist"

  [ -d "$SRC" ] || { echo "FAIL: $SRC does not exist — build first" >&2; exit 1; }

  printf '\n\033[1m==> %s portal -> s3://%s\033[0m\n' "$app" "$BUCKET"

  # Hashed assets, cached hard: Vite content-hashes the filenames, so a stale
  # copy is impossible and a year is both safe and correct.
  aws s3 sync "$SRC" "s3://${BUCKET}" --delete \
    --cache-control "public,max-age=31536000,immutable" \
    --exclude "index.html" --exclude "config.js" >/dev/null

  # Stable names, never cached. A cached config.js is a portal talking to the
  # previous environment's API until someone hard-refreshes — an outage with no
  # error message anywhere.
  aws s3 cp "$SRC/index.html" "s3://${BUCKET}/index.html" \
    --cache-control "no-cache" >/dev/null
  aws s3 cp "$CONFIG" "s3://${BUCKET}/config.js" \
    --cache-control "no-cache" --content-type "application/javascript" >/dev/null

  ID=$(aws cloudfront create-invalidation --distribution-id "$DIST" \
         --paths "/*" --query 'Invalidation.Id' --output text)
  echo "  synced, config.js restored, invalidation $ID"
done


# ── The widget host: the embeddable bundle AND the two customer pages ─────
#
# Not a portal, and deliberately handled apart from them:
#
#   - no config.js. The pages bake the gateway URL in at build time
#     (scripts/build-widget.sh), and a Yiji host page passes `gatewayUrl` to
#     YijiChat.init() itself.
#   - index.html IS published now. It is no longer the dev demo page: the
#     build emits a host page that can only take a GATEWAY-minted walk-in
#     session or send the visitor to the phone form (walk-in.html). The build
#     refuses to emit a page carrying the signing secret or the in-browser
#     mint (apps/chat-widget/vite.pages.config.ts), and this script checks
#     again, because a page that could mint a customer token for anybody must
#     never reach a public URL, however it got into dist/.
#   - `yiji-chat-widget.js` has a STABLE name, so five minutes, not a year.
#     The pages' own assets are content-hashed and cached for ever; the HTML
#     that names them is never cached, or a deploy would leave browsers
#     loading assets that no longer exist.
#   - `walk-in` (no extension) is uploaded beside `walk-in.html`, so a printed
#     QR code can carry the shorter address.
#   - `/` needs the distribution's DefaultRootObject set to index.html (a
#     one-time setting, checked below); S3 behind CloudFront has no notion of
#     a directory index.
if [ -z "$ONLY" ] || [ "$ONLY" = "widget" ]; then
  BUCKET="crm-${ENV_NAME}-widget"
  [ -n "$WIDGET_DIST" ] || die "no widget host for $ENV_NAME — create the bucket and distribution first"
  SRC="apps/chat-widget/dist"
  [ -d "$SRC" ] || die "$SRC does not exist — run scripts/build-widget.sh $ENV_NAME first"
  [ -f "$SRC/yiji-chat-widget.js" ] || die "$SRC/yiji-chat-widget.js is missing — the build did not produce a bundle"
  [ -f "$SRC/index.html" ] && [ -f "$SRC/walk-in.html" ] \
    || die "$SRC is missing index.html or walk-in.html — run scripts/build-widget.sh $ENV_NAME"

  # The pages must name THIS environment's API host. The widget bucket serves
  # files and nothing else, so a page built without one (or for the other
  # environment) would talk to the wrong gateway or to nobody.
  API_HOST="$(sed -n "s/.*SOCKET_URL: 'https\?:\/\/\([^']*\)'.*/\1/p" "$CONFIG")"
  grep -lq "$API_HOST" "$SRC"/assets/*.js \
    || die "no page asset names the $ENV_NAME API host ($API_HOST) — built for the wrong environment? run scripts/build-widget.sh $ENV_NAME"

  # Belt and braces after the build's own refusal: nothing that can mint a
  # customer token leaves this machine.
  if grep -rlE "SignJWT|dev-yiji-secret" "$SRC" --include='*.html' --include='*.js' | grep -q .; then
    die "a page in $SRC carries the in-browser token mint — refusing to publish"
  fi
  if [ -n "${YIJI_JWT_SECRET:-}" ] && grep -rlF "$YIJI_JWT_SECRET" "$SRC" | grep -q .; then
    die "a file in $SRC contains YIJI_JWT_SECRET — refusing to publish"
  fi

  printf '\n\033[1m==> widget -> s3://%s\033[0m\n' "$BUCKET"

  # The local static server's header file; meaningless on S3.
  rm -f "$SRC/serve.json"

  # Content-hashed page assets: cached hard, like the portals' bundles.
  aws s3 sync "$SRC/assets" "s3://${BUCKET}/assets" --delete \
    --cache-control "public,max-age=31536000,immutable" >/dev/null
  # Everything else except the pages, five minutes: the widget bundle's stable
  # name means a fix must be able to reach browsers the same day.
  aws s3 sync "$SRC" "s3://${BUCKET}" --delete \
    --exclude "assets/*" --exclude "*.html" --exclude "walk-in" \
    --cache-control "public,max-age=300" >/dev/null
  # The pages, never cached (they name the hashed assets).
  for page in index.html walk-in.html; do
    aws s3 cp "$SRC/$page" "s3://${BUCKET}/$page" \
      --cache-control "no-cache" --content-type "text/html; charset=utf-8" >/dev/null
  done
  aws s3 cp "$SRC/walk-in.html" "s3://${BUCKET}/walk-in" \
    --cache-control "no-cache" --content-type "text/html; charset=utf-8" >/dev/null

  ID=$(aws cloudfront create-invalidation --distribution-id "$WIDGET_DIST" \
         --paths "/*" --query 'Invalidation.Id' --output text)
  HOST="$(aws cloudfront get-distribution --id "$WIDGET_DIST" \
         --query 'Distribution.DomainName' --output text)"
  ROOT="$(aws cloudfront get-distribution-config --id "$WIDGET_DIST" \
         --query 'DistributionConfig.DefaultRootObject' --output text)"
  echo "  synced, invalidation $ID"
  echo "  chat    : https://${HOST}/"
  echo "  QR page : https://${HOST}/walk-in"
  echo "  embed   : https://${HOST}/yiji-chat-widget.js"
  if [ "$ROOT" != "index.html" ]; then
    echo "  WARN: $WIDGET_DIST has no DefaultRootObject, so https://${HOST}/ answers 403." >&2
    echo "        One-time fix (see docs/AWS-RESOURCES.md): set it to index.html." >&2
  fi
fi
echo
echo "Done. Invalidations take a minute or two to report Completed." 
