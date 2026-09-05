#!/usr/bin/env bash
#
# Post-deploy smoke test for the Yiji CRM stack.
#
# Verifies every service container reports healthy/ready AFTER a deploy, so a bad
# rollout is caught in seconds instead of by the first user. It execs each
# service's own health endpoint inside the container, so it works regardless of
# which ports are published to the host (the gateway's health port, for example,
# is internal-only).
#
# Usage:
#   ./scripts/smoke-test.sh
#   COMPOSE_FILES="-f docker-compose.prod.yml -f deploy/docker-compose.proxy.yml" ./scripts/smoke-test.sh
#
# Exit code 0 = all green; non-zero = at least one check failed.
set -uo pipefail

COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.prod.yml}"
# shellcheck disable=SC2086
DC() { docker compose ${COMPOSE_FILES} "$@"; }

fail=0

# Hit an in-container HTTP health endpoint via busybox wget (present in every
# image). -T = timeout seconds; -O - = write body to stdout (discarded).
incheck() {
  DC exec -T "$1" wget -q -T 5 -O - "$2"
}

check() {
  local name="$1"
  shift
  printf '  %-16s ' "$name"
  if "$@" >/dev/null 2>&1; then
    echo "OK"
  else
    echo "FAIL"
    fail=1
  fi
}

echo "Yiji CRM smoke test ($(date -u +%FT%TZ))"
echo "compose: ${COMPOSE_FILES}"
echo

check "directus"       incheck directus       http://localhost:8055/server/health
check "socket-gateway" incheck socket-gateway http://localhost:8081/ready
check "ai-gateway"     incheck ai-gateway     http://localhost:8081/ready
check "workers"        incheck workers        http://localhost:8090/health
check "agent-portal"   incheck agent-portal   http://localhost:80/
check "admin-portal"   incheck admin-portal   http://localhost:80/

echo
if [ "$fail" -eq 0 ]; then
  echo "all services healthy"
else
  echo "one or more checks failed - inspect logs: docker compose ${COMPOSE_FILES} logs --tail=50 <service>"
fi
exit "$fail"
