#!/usr/bin/env bash
# ============================================================================
# Yiji CRM — incident context collector
# ----------------------------------------------------------------------------
# Gathers EVERYTHING Claude needs to understand a production issue on its own:
# service health, PM2 status + error logs, Docker infra logs, recent git
# history, redacted env key list, and host resources. Writes one markdown
# report and prints its path.
#
#   scripts/incident/collect.sh                 # auto-collected context only
#   INCIDENT_NOTE="agents can't log in" scripts/incident/collect.sh
#   INCIDENT_LOG_LINES=400 scripts/incident/collect.sh
#
# Secrets are NEVER written — only env KEY NAMES are listed, values omitted.
# ============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LINES="${INCIDENT_LOG_LINES:-200}"
INFRA_COMPOSE="deploy/docker-compose.infra.yml"
OUT_DIR="$REPO_ROOT/scripts/incident/reports"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/incident-$TS.md"

have() { command -v "$1" >/dev/null 2>&1; }

# Probe a loopback HTTP endpoint; record status code + first body line.
probe() {
  local name="$1" url="$2" code body
  if have curl; then
    code="$(curl -s -o /tmp/yiji_probe_body -m 6 -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
    body="$(head -c 200 /tmp/yiji_probe_body 2>/dev/null | tr '\n' ' ')"
    printf -- '- **%s** `%s` → HTTP %s %s\n' "$name" "$url" "$code" "$body"
  else
    printf -- '- **%s** `%s` → (curl unavailable)\n' "$name" "$url"
  fi
}

{
  echo "# Yiji CRM — incident context"
  echo
  echo "- Collected: \`$TS\` (UTC)"
  echo "- Host: \`$(hostname 2>/dev/null || echo unknown)\`"
  echo
  echo "## Operator note"
  echo "${INCIDENT_NOTE:-_(none provided — diagnose automatically from the context below)_}"
  echo
  echo "## Service health (loopback)"
  probe "directus"       "http://127.0.0.1:8055/server/health"
  probe "socket-gateway" "http://127.0.0.1:8081/ready"
  probe "socket-gateway" "http://127.0.0.1:8081/health"
  probe "ai-gateway"     "http://127.0.0.1:8085/health"
  probe "ai-gateway"     "http://127.0.0.1:8085/ready"
  echo
  echo "## PM2 process status"
  if have pm2; then
    pm2 jlist 2>/dev/null | node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        try{
          const apps=JSON.parse(d);
          if(!apps.length){console.log("_(no PM2 processes)_");return;}
          for(const a of apps){const e=a.pm2_env||{};
            console.log(`- **${a.name}** — ${e.status} · restarts=${e.restart_time} · uptime=${e.pm_uptime?new Date(e.pm_uptime).toISOString():"?"} · pid=${a.pid}`);}
        }catch(err){console.log("_(could not parse pm2 jlist: "+err.message+")_");}
      });' 2>/dev/null || echo "_(pm2 jlist parse failed)_"
  else
    echo "_(pm2 not installed on this host)_"
  fi
  echo
  echo "## PM2 logs — recent (last $LINES lines, errors first)"
  echo '```'
  if have pm2; then pm2 logs --nostream --lines "$LINES" 2>&1 | tail -n "$LINES" || echo "(no pm2 logs)"; else echo "(pm2 not installed)"; fi
  echo '```'
  echo
  echo "## Docker infra logs (postgres / redis / directus, last $LINES lines)"
  echo '```'
  if have docker && [ -f "$INFRA_COMPOSE" ]; then
    docker compose -f "$INFRA_COMPOSE" logs --tail "$LINES" --no-color 2>&1 | tail -n "$LINES" || echo "(no docker logs)"
  else
    echo "(docker or $INFRA_COMPOSE unavailable)"
  fi
  echo '```'
  echo
  echo "## Recent git history (the change set most likely to have caused a regression)"
  echo '```'
  git log --oneline -12 2>/dev/null
  echo "--- working tree ---"
  git status -sb 2>/dev/null
  echo '```'
  echo
  echo "## Environment keys present (values redacted)"
  echo '```'
  if [ -f .env.prod ]; then grep -oE '^[A-Z0-9_]+' .env.prod 2>/dev/null | sort -u; else echo "(no .env.prod)"; fi
  echo '```'
  echo
  echo "## Host resources"
  echo '```'
  { df -h 2>/dev/null | head -6; echo; free -m 2>/dev/null; echo; uptime 2>/dev/null; } || echo "(resource tools unavailable)"
  echo '```'
} > "$REPORT" 2>&1

rm -f /tmp/yiji_probe_body 2>/dev/null || true
echo "$REPORT"
