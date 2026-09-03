#!/usr/bin/env bash
#
# deploy-portals.sh — publish the built portals to S3 + CloudFront.
#
#   scripts/deploy-portals.sh staging            # both portals
#   scripts/deploy-portals.sh staging admin      # just one
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

ENV_NAME="${1:-}"
ONLY="${2:-}"

case "$ENV_NAME" in
  staging|prod) ;;
  *) echo "usage: $0 <staging|prod> [agent|admin]" >&2; exit 2 ;;
esac

# CloudFront distribution per bucket. Kept beside the bucket names so a deploy
# can never sync one environment and invalidate another.
case "$ENV_NAME" in
  staging)
    AGENT_DIST=E24IIVRFOW7GH4
    ADMIN_DIST=E1VN06BCLZ6Q4F
    ;;
  prod)
    AGENT_DIST=E3UK8T8DHFGMNW
    ADMIN_DIST=E37XKA7D2IPZLC
    ;;
esac

CONFIG="$(mktemp -t portal-config.XXXXXX.js)"
trap 'rm -f "$CONFIG"' EXIT
scripts/gen-portal-config.sh "$ENV_NAME" "$CONFIG" >/dev/null

for app in agent admin; do
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

echo
echo "Done. Invalidations take a minute or two to report Completed."
