#!/usr/bin/env bash
# ============================================================================
# Yiji CRM — OPERATIONAL remediation (you describe it; Claude fixes the runtime)
# ----------------------------------------------------------------------------
# For issues that are NOT code bugs: a service is down / crash-looping, a
# container died, schema/roles weren't applied, a token is wrong, nginx needs a
# reload, disk is full, etc. Claude gathers the system context, diagnoses from
# YOUR description + that context, and PERFORMS the safe operational fix
# (restart / reload / re-bootstrap) then verifies — or, for anything risky
# (secrets, data, host-level), tells you the exact command to run and why.
#
# No branch, no test gate — this is runtime ops, not a code change.
#
#   scripts/incident/ops.sh "directus keeps restarting after the deploy"
#   scripts/incident/ops.sh "agents say the inbox won't load"
#
# Requires: Claude Code CLI (`claude`) + ANTHROPIC_API_KEY. Env:
#   CLAUDE_BIN (default claude), CLAUDE_FLAGS (default: unattended-capable)
# ============================================================================
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DESC="${1:-}"
if [ -z "$DESC" ]; then
  echo "Describe the operational issue, e.g.:" >&2
  echo "  scripts/incident/ops.sh \"socket-gateway is online but agents can't connect\"" >&2
  exit 2
fi

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "Claude Code CLI ('$CLAUDE_BIN') not on PATH." >&2; exit 3; }

echo "▶ collecting system context…"
REPORT="$(INCIDENT_NOTE="$DESC" scripts/incident/collect.sh)"
echo "  context: $REPORT"

CLAUDE_FLAGS="${CLAUDE_FLAGS:---dangerously-skip-permissions}"

PROMPT="$(cat <<EOF
You are the on-call SRE for the Yiji CRM. Hybrid deployment:
- Docker infra: Postgres, Redis, Directus 11 (deploy/docker-compose.infra.yml, loopback).
- PM2 services: socket-gateway (8080 + 8081 http), ai-gateway (8085), workers.
- nginx edge (deploy/nginx/yiji-crm.conf) serves the SPAs + reverse-proxies TLS.

An OPERATIONAL incident has been reported (it may NOT be a code bug). Diagnose from
the operator's description + the system context below + your own live inspection,
then resolve it.

Operator description:
  $DESC

You MAY perform these SAFE operational actions, then VERIFY with health checks:
- PM2:    pm2 restart|reload <svc>   |   pm2 reload all   |   pm2 flush   |   pm2 logs/jlist
- Infra:  docker compose -f deploy/docker-compose.infra.yml restart|up -d <svc>   |   logs   |   ps
- Schema: docker compose -f deploy/docker-compose.infra.yml run --rm bootstrap
          (or: pnpm --filter @yiji/directus-bootstrap apply)  — idempotent, safe to re-run
- nginx:  nginx -t && systemctl reload nginx   (validate first; reload, never hard-restart blindly)
- Inspect freely: curl loopback /health|/ready|/metrics, df -h, free -m, redis-cli ping
- Free space SAFELY: rotate/truncate app logs, pm2 flush

You MUST NOT do these — instead give the operator the EXACT command(s) + why:
- Touch .env*/secrets. You never edit or print secrets; if a token/secret is wrong
  or expired, tell the operator precisely what to set/rotate and which service to reload.
- Anything that risks DATA: db drop/restore, \`docker compose down -v\`, volume/image
  prune, deleting uploads.
- Host-level / irreversible: restart the Docker daemon, reboot, kill -9 sprees.
- Code changes. If the root cause is actually a code bug, STOP and say so — that goes
  through scripts/incident/respond.sh (branch + tests), not here.

Work step by step: inspect → form a hypothesis → take the smallest safe action →
re-verify with health checks → repeat if needed. Then report: what was wrong, the
exact commands you ran, the verification result, and any operator follow-up
(e.g. a secret to set). If you cannot safely resolve it, hand back a precise
remediation plan instead of guessing.

--- SYSTEM CONTEXT ---
$(cat "$REPORT")
EOF
)"

echo "▶ routing to Claude (operational remediation)…"
# shellcheck disable=SC2086
"$CLAUDE_BIN" -p "$PROMPT" $CLAUDE_FLAGS
echo "▶ done — re-check health:  scripts/incident/detect.sh"
