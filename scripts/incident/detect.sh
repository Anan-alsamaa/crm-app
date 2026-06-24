#!/usr/bin/env bash
# ============================================================================
# Yiji CRM — incident detector (the "is something wrong?" gate)
# ----------------------------------------------------------------------------
# Fast, dependency-light health probe of the whole stack. Prints a one-line
# summary per problem found. Exit 0 = healthy, 1 = issue(s) detected.
#
# This is what makes remediation AUTOMATIC: run it on a short cron (or via
# watch.sh); when it exits non-zero, fire scripts/incident/respond.sh so Claude
# investigates without a human noticing first.
#
#   scripts/incident/detect.sh && echo OK || echo "issues found"
# ============================================================================
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

issues=()
have() { command -v "$1" >/dev/null 2>&1; }

# 1) HTTP health endpoints (loopback). A non-2xx/3xx or no answer is an issue.
check_http() {
  local name="$1" url="$2" code
  have curl || return 0
  code="$(curl -s -o /dev/null -m 6 -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  case "$code" in
    2*|3*) : ;;
    *) issues+=("$name unhealthy (HTTP $code at $url)") ;;
  esac
}
check_http "directus"       "http://127.0.0.1:8055/server/health"
check_http "socket-gateway" "http://127.0.0.1:8081/ready"
check_http "ai-gateway"     "http://127.0.0.1:8085/health"

# 2) PM2: any service not 'online', or restart-storming (>5 restarts), is an issue.
if have pm2; then
  pm2_issues="$(pm2 jlist 2>/dev/null | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{for(const a of JSON.parse(d)){const e=a.pm2_env||{};
        if(e.status!=="online") console.log(`${a.name} is ${e.status}`);
        else if((e.restart_time||0)>5) console.log(`${a.name} restart-storming (${e.restart_time})`);
      }}catch(_){}
    });' 2>/dev/null)"
  [ -n "$pm2_issues" ] && while IFS= read -r line; do [ -n "$line" ] && issues+=("$line"); done <<< "$pm2_issues"
fi

# 3) Docker infra containers all running?
if have docker && [ -f deploy/docker-compose.infra.yml ]; then
  not_up="$(docker compose -f deploy/docker-compose.infra.yml ps --status=exited --status=dead -q 2>/dev/null)"
  [ -n "$not_up" ] && issues+=("one or more infra containers are not running")
fi

if [ "${#issues[@]}" -gt 0 ]; then
  printf 'UNHEALTHY: %s\n' "${issues[@]}"
  exit 1
fi
echo "healthy"
exit 0
