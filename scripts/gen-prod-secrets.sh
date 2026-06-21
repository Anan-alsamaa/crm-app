#!/usr/bin/env bash
#
# Generate the strong [GENERATE] secrets for a production .env.prod.
# Each is 32 random bytes (hex) via openssl — well above the >=32-char minimum
# the env guards enforce.
#
# Usage:
#   scripts/gen-prod-secrets.sh              # print to stdout
#   scripts/gen-prod-secrets.sh >> .env.prod # append into your env file
#
# Then fill the [PROVIDE] values (URLs, admin password, SMTP, DB host) from
# .env.prod.example, chmod 600 .env.prod, and NEVER commit it.
#
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found — install it or generate 32-byte hex secrets another way" >&2
  exit 1
fi

gen() { openssl rand -hex 32; }

cat <<EOF
# --- generated $(date -u +%Y-%m-%dT%H:%M:%SZ) — keep secret, do not commit ---
DIRECTUS_KEY=$(gen)
DIRECTUS_SECRET=$(gen)
YIJI_JWT_SECRET=$(gen)
SVC_GATEWAY_TOKEN=$(gen)
SVC_WORKERS_TOKEN=$(gen)
SVC_AI_TOKEN=$(gen)
DB_PASSWORD=$(gen)
EOF
