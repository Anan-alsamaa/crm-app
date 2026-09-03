#!/usr/bin/env bash
#
# gen-portal-config.sh — write a portal's runtime config.js for an S3 deploy.
#
#   scripts/gen-portal-config.sh <env> [outfile]
#
#     scripts/gen-portal-config.sh staging dist/config.js
#     scripts/gen-portal-config.sh prod    dist/config.js
#
# WHY THIS EXISTS
#
# The portals read their API URLs at RUNTIME from `window.__SARA_CONFIG__`,
# which `/config.js` defines. In a container that file is written at start-up by
# apps/*/docker-entrypoint.sh from the container's environment — that is what
# lets one image serve every environment.
#
# On S3 + CloudFront there IS no container and no entrypoint, so nothing writes
# it. Without this script the portal falls through to whatever `VITE_*` value
# was baked in at build time, which means the bundle is environment-specific and
# build-once is lost for the portals.
#
# This script writes the same file CI can upload to each bucket beside the
# bundle, so the SAME bundle serves both environments — build-once preserved.
#
# Resolution order in the app (packages/shared-config/src/runtime.ts):
#   1. window.__SARA_CONFIG__   <- this file
#   2. the build-time VITE_* value
#   3. a loopback fallback
#
# Emit it with the SAME shape as docker-entrypoint.sh, including omitting unset
# keys rather than writing them empty: an empty string is not nullish, so it
# would win over the build-time value and resolve to nothing.
set -euo pipefail

ENV_NAME="${1:-}"
OUT="${2:-config.js}"

case "$ENV_NAME" in
  staging) SUFFIX="staging.crm.anan.sa" ;;
  prod)    SUFFIX="crm.anan.sa" ;;
  *) echo "usage: $0 <staging|prod> [outfile]" >&2; exit 2 ;;
esac

# Every URL the portals resolve. JOB_PRODUCER_URL is the socket-gateway's REST
# app (Import CSV, Run report, assignment notifications) — it is deliberately
# NOT baked at build time (see .github/workflows/deploy.yml), so if it is
# missing HERE it falls back to loopback and three features fail silently,
# because the producer call is best-effort and its caller swallows the error.
DIRECTUS_URL="https://api.${SUFFIX}"
SOCKET_URL="https://ws.${SUFFIX}"
AI_GATEWAY_URL="https://ai.${SUFFIX}"
JOB_PRODUCER_URL="https://jobs.${SUFFIX}"

mkdir -p "$(dirname "$OUT")"
{
  echo "/* Generated for ${ENV_NAME} by scripts/gen-portal-config.sh. Do not edit. */"
  echo 'window.__SARA_CONFIG__ = {'
  echo "  DIRECTUS_URL: '${DIRECTUS_URL}',"
  echo "  SOCKET_URL: '${SOCKET_URL}',"
  echo "  AI_GATEWAY_URL: '${AI_GATEWAY_URL}',"
  echo "  JOB_PRODUCER_URL: '${JOB_PRODUCER_URL}',"
  echo '};'
} > "$OUT"

echo "wrote $OUT for $ENV_NAME:"
cat "$OUT"

# config.js MUST NOT be cached like the hashed bundle assets. Vite emits
# content-hashed filenames, so those are safe to cache for a year — but this
# file has a stable name and changes when an environment is reconfigured. Upload
# it with:
#   aws s3 cp config.js s3://<bucket>/config.js --cache-control "no-cache"
# A cached config.js is a portal pointing at the previous environment's API
# until someone hard-refreshes, which reads as an outage with no error.
