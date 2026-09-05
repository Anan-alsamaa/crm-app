#!/usr/bin/env bash
#
# try-directus.sh — run the custom Directus image against the staging database.
#
#   bash scripts/try-directus.sh          # start it
#   bash scripts/try-directus.sh --stop   # remove it
#
# Then open http://localhost:8099
#
# WHY A SCRIPT AND NOT A PASTED COMMAND
#
# The docker run needs ~12 values out of .env.staging. Sourcing that file and
# running docker as two separate shell commands silently loses them — the
# container then falls back to Directus's default DB_HOST of localhost and dies
# with ECONNREFUSED 127.0.0.1:5432, which reads like a database problem rather
# than a missing variable. `--env-file` hands the file to Docker directly, so
# there is no shell step to get wrong.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NAME=crm-directus-test
PORT=8099

if [ "${1:-}" = "--stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME" || echo "$NAME was not running"
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  docker ps -a --filter "name=$NAME" --format 'container: {{.Names}}  {{.Status}}' | grep .     || { echo "not running — start it with: bash scripts/try-directus.sh"; exit 1; }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${PORT}/server/health" || true)
  echo "health HTTP: ${code:-no answer}"
  [ "$code" = "200" ] && echo "READY -> http://localhost:${PORT}" || echo "still starting, or check: docker logs $NAME"
  exit 0
fi

[ -f .env.staging ] || { echo "FAIL: .env.staging not found (it is gitignored — it lives only on this machine)" >&2; exit 1; }

# Docker's --env-file does NOT understand quotes, `export`, or inline comments,
# and .env.staging has comment lines throughout. Filter to the plain KEY=VALUE
# lines this container actually needs, stripping any surrounding quotes.
# NOT mktemp + an EXIT trap: Ctrl-C during the wait loop would fire the trap
# and could pull the file away from Docker, leaving no container behind. This
# path is stable and gitignored, and is overwritten on each run.
TMP="$ROOT/.directus-test.env"
grep -E '^(DB_HOST|DB_PORT|DB_DATABASE|DB_USER|DB_PASSWORD|DIRECTUS_KEY|DIRECTUS_SECRET|DIRECTUS_ADMIN_EMAIL|DIRECTUS_ADMIN_PASSWORD)=' .env.staging \
  | sed 's/^\([A-Z_]*\)="\(.*\)"$/\1=\2/; s/^\([A-Z_]*\)='"'"'\(.*\)'"'"'$/\1=\2/' > "$TMP"

# Fail loudly here rather than letting the container fall back to localhost.
DB_HOST_VAL="$(grep '^DB_HOST=' "$TMP" | cut -d= -f2-)"
[ -n "$DB_HOST_VAL" ] || { echo "FAIL: DB_HOST is empty in .env.staging" >&2; exit 1; }
echo "DB_HOST -> $DB_HOST_VAL"

cat >> "$TMP" <<EOF
DB_CLIENT=pg
DB_SSL__REJECT_UNAUTHORIZED=false
PUBLIC_URL=http://localhost:${PORT}
WEBSOCKETS_ENABLED=true
CACHE_ENABLED=false
TELEMETRY=false
EOF

# NOT DB_SSL=true. Setting the parent as a plain boolean overrides the nested
# object the double underscore builds, so node-postgres verifies RDS's untrusted
# CA and the container dies at boot with SELF_SIGNED_CERT_IN_CHAIN. Proved
# 2026-09-02. (The bootstrap job is the exception — its own pg client reads it.)

docker rm -f "$NAME" >/dev/null 2>&1 || true

# The corporate resolver cannot resolve the RDS hostname from inside Docker
# (getaddrinfo EAI_AGAIN), so pin a public DNS server and the address we
# resolved through 8.8.8.8. Neither flag is needed on ECS, which uses VPC DNS.
docker run -d --name "$NAME" -p "${PORT}:8055" \
  --dns 8.8.8.8 \
  --add-host "test-yiji.ctqnuieahhb8.us-east-2.rds.amazonaws.com:18.223.62.15" \
  --env-file "$TMP" \
  crm/directus:test >/dev/null

# The container is ALREADY RUNNING at this point. Interrupting the wait below
# (Ctrl-C) does not stop it — check with `--status` and open the port when it
# answers. Nothing here needs to keep running for the container to come up.
echo "started — waiting for boot (Directus runs migrations first)"
echo "  (safe to Ctrl-C: the container keeps starting. Check: bash scripts/try-directus.sh --status)"
# Give Docker a moment before the first check: `docker ps` can briefly return
# nothing while a container is still being created, and treating that single
# empty result as "it exited" is what previously tore the container down a
# second after starting it.
sleep 5
misses=0
for i in $(seq 1 36); do
  if docker ps --filter "name=$NAME" --format '{{.Names}}' | grep -q .; then
    misses=0
  else
    # Two consecutive misses, not one — a transient empty result is not proof.
    misses=$((misses + 1))
    if [ "$misses" -ge 2 ]; then
      echo
      echo "CONTAINER EXITED. Last lines:"
      docker logs "$NAME" 2>&1 | grep -viE 'update available|versions behind|releases|^\s*[│╭╰]' | tail -12
      exit 1
    fi
  fi
  if curl -fsS --max-time 3 "http://localhost:${PORT}/server/health" >/dev/null 2>&1; then
    echo
    echo "UP after ~$((i*5))s"
    echo
    echo "Extensions loaded:"
    docker logs "$NAME" 2>&1 | grep -i "Loaded extensions" | tail -1 | sed 's/^/  /'
    echo
    echo "  Open  http://localhost:${PORT}"
    echo "  Stop  bash scripts/try-directus.sh --stop"
    echo
    echo "Expected, both fine:"
    echo "  - admin login says INVALID_CREDENTIALS: ADMIN_EMAIL/PASSWORD seed an"
    echo "    admin only on an EMPTY database. crm_staging was restored with its"
    echo "    own 17 users and their existing passwords."
    echo "  - health says 'warn': pg latency ~200ms from here to Ohio, against a"
    echo "    150ms threshold. Single-digit ms from ECS in us-east-2."
    exit 0
  fi
  printf '.'
  sleep 5
done
echo
echo "still not healthy after 3 minutes — recent logs:"
docker logs "$NAME" 2>&1 | tail -15
exit 1
