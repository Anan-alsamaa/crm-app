#!/usr/bin/env bash
#
# deploy-staging.sh — bring the Sara CRM staging stack up on the staging EC2 box.
#
#   scripts/deploy-staging.sh                 # deploy / update
#   scripts/deploy-staging.sh --bootstrap     # also apply schema+roles+tokens
#   scripts/deploy-staging.sh --check         # preflight only, change nothing
#   scripts/deploy-staging.sh --build         # build images on this host
#
# Runs on the STAGING HOST, from the repo root. Idempotent: safe to re-run, and
# safe to re-run after a partial failure.
#
# Shape (see docs/ECS-RETIREMENT-AND-STAGING-CUTOVER.md):
#   database  -> shared RDS `crm_staging`, PUBLIC endpoint, TLS, NOT on this box
#   redis     -> redis:7-alpine ON this box (ElastiCache is in another VPC)
#   services  -> docker-compose.prod.yml + deploy/docker-compose.staging.yml
#   project   -> crm-staging (namespaces volumes/networks away from crm-prod)
#
# The preflight is the point of this script. Every check below is something that
# has actually failed once, and each fails LOUDLY here instead of silently at
# 3am: a placeholder password, a DNS resolver that lies, an unreachable
# database, a coupon switch left on.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env.staging}"
PROJECT="${PROJECT:-crm-staging}"
COMPOSE=(docker compose --project-name "$PROJECT" --env-file "$ENV_FILE"
         -f docker-compose.prod.yml -f deploy/docker-compose.staging.yml)

DO_BOOTSTRAP=0; CHECK_ONLY=0; DO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --bootstrap) DO_BOOTSTRAP=1 ;;
    --check)     CHECK_ONLY=1 ;;
    --build)     DO_BUILD=1 ;;
    -h|--help)   sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { red "FAIL: $*"; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
step "Preflight"

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. It is gitignored — copy it to this host by hand (scp); it is NOT in the repo."

# Permissions: this file holds every secret for the environment.
if [ "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)" != "600" ]; then
  ylw "  $ENV_FILE is not chmod 600 — fixing"
  chmod 600 "$ENV_FILE"
fi

# Load it for our own checks (compose reads it separately via --env-file).
set -a; . "./$ENV_FILE"; set +a

# --- the placeholders that must be filled before first boot ----------------
# Compose's ${VAR:?} guards catch EMPTY, but not a leftover placeholder string,
# and DIRECTUS_ADMIN_PASSWORD was the known-outstanding one at handover.
for var in DB_HOST DB_DATABASE DB_USER DB_PASSWORD DIRECTUS_KEY DIRECTUS_SECRET \
           DIRECTUS_ADMIN_EMAIL DIRECTUS_ADMIN_PASSWORD DIRECTUS_PUBLIC_URL \
           CORS_ORIGIN SMTP_HOST YIJI_JWT_SECRET \
           SVC_GATEWAY_TOKEN SVC_WORKERS_TOKEN SVC_AI_TOKEN; do
  val="${!var:-}"
  [ -n "$val" ] || die "$var is empty in $ENV_FILE"
  case "$val" in
    *CHANGEME*|*PLACEHOLDER*|*REPLACE*|*TODO*|*FILLME*)
      die "$var still holds a placeholder value" ;;
  esac
done
grn "  required values present, no placeholders"

# --- the one setting that must never be wrong on staging -------------------
# Staging shares the REAL Yiji tenant. `on` here hands real customers real money
# for test data, and it works from a BACKLOG — the first sweep after it goes
# live sends every approved-and-undelivered coupon at once.
if [ "${YIJI_COUPON_DELIVERY:-off}" != "off" ]; then
  die "YIJI_COUPON_DELIVERY=${YIJI_COUPON_DELIVERY} — MUST be off on staging (real money, real customers)"
fi
grn "  YIJI_COUPON_DELIVERY=off"

# --- staging must not point at the dead or the production database ---------
case "${DB_DATABASE}" in
  crm_staging) grn "  DB_DATABASE=crm_staging" ;;
  afcoCrm)     die "DB_DATABASE=afcoCrm is the DEAD 2026-08-06 ECS database (schema 3 weeks stale, no business data). Use crm_staging." ;;
  *)           ylw "  DB_DATABASE=${DB_DATABASE} — expected crm_staging; continuing" ;;
esac

# --- Redis: on-box, not the cross-VPC ElastiCache --------------------------
# ElastiCache lives at a PRIVATE address in vpc-08ea7d710f4596303; this box is
# in the default VPC. Separate VPCs do not route. If REDIS_URL names the
# clustercfg endpoint the stack starts and then fails at the first job with
# `Failed to refresh slots cache`, which reads as a Redis bug, not a routing one.
case "${REDIS_URL:-}" in
  *clustercfg*)
    die "REDIS_URL points at ElastiCache. It is in a DIFFERENT VPC and unreachable from this box — unset REDIS_URL to use the on-box redis:7-alpine." ;;
  "") grn "  REDIS_URL unset -> on-box redis://redis:6379" ;;
  *)  ylw "  REDIS_URL=${REDIS_URL}" ;;
esac

# --- database reachability, through a resolver that does not lie -----------
# Corporate DNS appends .althawaqh.com and answers 10.1.10.22 for ANY name, so a
# reachability test on the office network is meaningless unless it resolves
# publicly. On the EC2 box this is moot, but the script also gets run from a
# laptop and the false pass is expensive.
step "Database reachability"
if command -v getent >/dev/null 2>&1; then
  resolved="$(getent hosts "$DB_HOST" | awk '{print $1; exit}' || true)"
  [ -n "$resolved" ] || die "cannot resolve $DB_HOST"
  if [ "$resolved" = "10.1.10.22" ]; then
    die "$DB_HOST resolved to 10.1.10.22 — the corporate resolver is lying. Every reachability result here is meaningless; use a public resolver."
  fi
  echo "  $DB_HOST -> $resolved"
fi
# TCP probe. `timeout` bounds it: a dropped packet (security group) otherwise
# hangs for the kernel's full SYN retry budget (~2 min) and looks like a stall.
if timeout 10 bash -c "cat < /dev/null > /dev/tcp/${DB_HOST}/${DB_PORT:-5432}" 2>/dev/null; then
  grn "  TCP ${DB_HOST}:${DB_PORT:-5432} open"
else
  die "cannot reach ${DB_HOST}:${DB_PORT:-5432} — check the RDS security group allows this box"
fi

# --- compose file validity -------------------------------------------------
step "Compose config"
"${COMPOSE[@]}" config --quiet || die "compose config did not resolve"
services="$("${COMPOSE[@]}" config --services | sort | tr '\n' ' ')"
echo "  services: $services"
case " $services " in
  *" postgres "*) die "the bundled postgres is still in the resolved config — the staging overlay did not apply. Staging uses RDS." ;;
esac
grn "  bundled postgres correctly absent (database is RDS)"

if [ "$CHECK_ONLY" = "1" ]; then
  step "Preflight passed (--check: nothing was changed)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Images
# ---------------------------------------------------------------------------
if [ "$DO_BUILD" = "1" ]; then
  step "Building images on this host (IMAGE_TAG=${IMAGE_TAG:-latest})"
  # Building on a t3.small will OOM the TypeScript builds. Named here because
  # the failure is an opaque exit 137, not a message about memory.
  ylw "  NOTE: a t3.small (2 GB) cannot build these images — expect exit 137 (OOM)."
  ylw "  Prefer pulling from the registry; --build is for a box with >= 4 GB."
  "${COMPOSE[@]}" build
else
  step "Pulling images (IMAGE_TAG=${IMAGE_TAG:-latest})"
  # A first deploy before CI has ever pushed will fail here. That is honest —
  # better than silently running a stale local image.
  "${COMPOSE[@]}" pull || die "pull failed — is IMAGE_TAG=${IMAGE_TAG:-latest} present in ${REGISTRY:-the registry}? Use --build to build on this host."
fi

# ---------------------------------------------------------------------------
# 2. Up
# ---------------------------------------------------------------------------
step "Starting stack (project: $PROJECT)"
"${COMPOSE[@]}" up -d --remove-orphans

# Wait for Directus rather than racing it. It runs migrations on first boot and
# can take well over a minute; the bootstrap and every smoke check below depend
# on it being genuinely ready, not merely started.
step "Waiting for Directus to become healthy"
deadline=$(( $(date +%s) + 300 ))
while :; do
  state="$("${COMPOSE[@]}" ps --format json directus 2>/dev/null | tr ',' '\n' | grep -o '"Health":"[a-z]*"' | head -1 | cut -d'"' -f4 || true)"
  case "$state" in
    healthy) grn "  directus healthy"; break ;;
    unhealthy) "${COMPOSE[@]}" logs --tail 40 directus; die "directus went unhealthy" ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    "${COMPOSE[@]}" logs --tail 40 directus
    die "directus not healthy after 5 minutes"
  fi
  sleep 5
done

# ---------------------------------------------------------------------------
# 3. Bootstrap (opt-in)
# ---------------------------------------------------------------------------
# Idempotent and ADDITIVE — it adds collections/fields/permissions, never drops.
# Run it when the schema changed, after a restore, or to rotate SVC_* tokens.
# `crm_staging` was restored WITH its schema, so a first deploy does not strictly
# need it — but run it once anyway to seed the service accounts if they are
# missing (the 2026-08-06 ECS bootstrap skipped them when SVC_* were unset, and
# without those users the three Node services cannot authenticate at all).
if [ "$DO_BOOTSTRAP" = "1" ]; then
  step "Applying bootstrap (schema + roles + service tokens)"
  "${COMPOSE[@]}" run --rm bootstrap || die "bootstrap failed — see the log above. If it failed at the CONSTRAINTS step, DB_SSL is not reaching it."
  grn "  bootstrap applied"
else
  ylw ""
  ylw "Skipping bootstrap (pass --bootstrap to apply schema/roles/tokens)"
fi

# ---------------------------------------------------------------------------
# 4. Smoke
# ---------------------------------------------------------------------------
step "Smoke checks"
fails=0
probe() { # name url
  if curl -fsS --max-time 10 "$2" >/dev/null 2>&1; then
    grn "  ok   $1"
  else
    red "  FAIL $1 ($2)"; fails=$((fails+1))
  fi
}
probe "directus  /server/health" "http://127.0.0.1:${DIRECTUS_PORT:-8055}/server/health"
probe "gateway   /ready"         "http://127.0.0.1:${SOCKET_GATEWAY_HTTP_PORT:-8082}/ready"
probe "ai        /health"        "http://127.0.0.1:${AI_GATEWAY_PORT:-8081}/health"
probe "agent portal"             "http://127.0.0.1:${AGENT_PORTAL_PORT:-8090}/"
probe "admin portal"             "http://127.0.0.1:${ADMIN_PORTAL_PORT:-8092}/"

# Directus reports its dependencies by ROLE, not backend: there is no `redis`
# key, so grepping for one returns nothing and reads as "Redis is off" when it
# is connected. `cache` is the proof.
if curl -fsS --max-time 10 "http://127.0.0.1:${DIRECTUS_PORT:-8055}/server/health" 2>/dev/null | grep -q '"cache"'; then
  grn "  ok   redis (health reports 'cache' — there is deliberately no 'redis' key)"
else
  ylw "  warn redis/cache not reported healthy by Directus"
fi

step "Recent errors in the logs"
"${COMPOSE[@]}" logs --since 5m 2>/dev/null | grep -iE "error|fatal" | grep -viE "no error|error_|errorCount" | tail -15 || echo "  (none)"

if [ "$fails" -gt 0 ]; then
  red ""
  red "$fails smoke check(s) failed — the stack is up but not serving."
  exit 1
fi

step "Staging is up"
cat <<EOF

  project   $PROJECT
  database  ${DB_DATABASE} on ${DB_HOST}
  images    ${REGISTRY:-local}:${IMAGE_TAG:-latest}
  coupons   delivery OFF (correct for staging)

  Next: point Caddy at the loopback ports, then run the section 4 checklist in
  docs/RELEASE.md before promoting anything to production.
EOF
