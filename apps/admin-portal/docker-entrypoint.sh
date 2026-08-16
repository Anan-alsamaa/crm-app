#!/bin/sh
# Write the portal's runtime configuration, then start nginx.
#
# This is what makes one image serve every environment. The bundle is
# identical in staging and production; only this file differs, and it is
# written from the container's own environment at start-up — so the artifact
# that passed staging is byte-for-byte the artifact that ships.
#
# Unset variables are omitted rather than written empty, so the portal falls
# back to its build-time value and then to loopback, which is what keeps local
# development working unchanged.
set -eu

CONFIG=/usr/share/nginx/html/config.js
{
  echo '/* Generated at container start. Do not edit. */'
  echo 'window.__SARA_CONFIG__ = {'
  [ -n "${DIRECTUS_URL:-}" ]    && echo "  DIRECTUS_URL: '${DIRECTUS_URL}',"
  [ -n "${SOCKET_URL:-}" ]      && echo "  SOCKET_URL: '${SOCKET_URL}',"
  [ -n "${AI_GATEWAY_URL:-}" ]  && echo "  AI_GATEWAY_URL: '${AI_GATEWAY_URL}',"
  echo '};'
} > "$CONFIG"

echo "runtime config written:"
cat "$CONFIG"

exec "$@"
