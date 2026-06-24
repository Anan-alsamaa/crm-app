#!/usr/bin/env bash
# ============================================================================
# Yiji CRM — Claude remediation driver
# ----------------------------------------------------------------------------
# Hands an incident report to Claude Code (headless) so it diagnoses the root
# cause from the system's own context + the codebase, makes the MINIMAL fix on
# a fresh branch, and proves it with typecheck + the test suite. No human edits
# code — Claude does, and the test gate is the safety net.
#
#   scripts/incident/remediate.sh [path/to/incident-report.md]
#       (defaults to the newest report in scripts/incident/reports/)
#
# Requires: Claude Code CLI (`claude`) on PATH + ANTHROPIC_API_KEY in the env.
# Env knobs:
#   CLAUDE_BIN        claude binary (default: claude)
#   CLAUDE_FLAGS      extra flags (default: headless, edits+bash allowed)
#   INCIDENT_AUTODEPLOY=1   after green tests, commit + `pm2 reload all` (opt-in)
# ============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

REPORT="${1:-$(ls -t scripts/incident/reports/incident-*.md 2>/dev/null | head -1)}"
if [ -z "${REPORT:-}" ] || [ ! -f "$REPORT" ]; then
  echo "No incident report found. Run scripts/incident/collect.sh first." >&2
  exit 2
fi

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "Claude Code CLI ('$CLAUDE_BIN') not found on PATH. Install it on this host first." >&2
  exit 3
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BRANCH="fix/incident-$TS"
git checkout -b "$BRANCH" >/dev/null 2>&1 || git checkout "$BRANCH"
echo "→ working on branch $BRANCH"

# This runs UNATTENDED (cron/respond.sh), so Claude must use its tools without
# permission prompts — hence --dangerously-skip-permissions by default. The
# compensating controls are real: it works only on a throwaway fix/incident-*
# branch, the prompt forbids editing .env*/secrets and destructive commands, and
# the independent typecheck+test gate below refuses to mark a bad fix deployable.
# For a supervised/interactive run, override to tighten, e.g.:
#   CLAUDE_FLAGS="--permission-mode acceptEdits --allowedTools Read,Edit,Grep,Glob,Bash"
CLAUDE_FLAGS="${CLAUDE_FLAGS:---dangerously-skip-permissions}"

PROMPT="$(cat <<EOF
You are the on-call engineer for the Yiji CRM (a pnpm/TypeScript monorepo:
Directus + Postgres + Redis in Docker; socket-gateway, ai-gateway, workers as
Node/tsx services under PM2; React/Preact portals served by nginx). A PRODUCTION
incident has been detected. Below is the system's own diagnostic context.

Do this, end to end:
1. Diagnose the ROOT CAUSE from the logs / health / git history below + by reading
   the code. State it explicitly before fixing.
2. Make the MINIMAL, targeted code fix. Do not refactor unrelated code.
3. Run \`pnpm -r --if-present typecheck\` and \`pnpm test\` and make them pass.
4. Write a concise summary: root cause, the fix, files changed, test results, and
   the exact deploy command to apply it (this is a hybrid deploy: git pull on the
   server, \`pnpm install --frozen-lockfile\` if deps changed, then \`pm2 reload all\`;
   rebuild the frontend only if a portal/widget changed).

Hard rules:
- NEVER edit .env* files or print/commit secrets.
- NEVER run destructive commands (no db drops, no rm -rf, no force-push, no
  history rewrite). Work only on the current branch ($BRANCH).
- If the root cause is configuration/secrets/infra (not code), DO NOT guess a code
  change — report exactly what an operator must set/restart instead.
- If you cannot reproduce or are not confident, say so and propose the safest next
  diagnostic step rather than a speculative fix.

--- INCIDENT CONTEXT ---
$(cat "$REPORT")
EOF
)"

echo "→ invoking Claude Code (headless) to diagnose + fix…"
# shellcheck disable=SC2086
"$CLAUDE_BIN" -p "$PROMPT" $CLAUDE_FLAGS
CLAUDE_RC=$?
echo "→ Claude exited with code $CLAUDE_RC"

# Independent verification gate — never trust the fix without a green run.
echo "→ verifying: typecheck + tests"
GATE_OK=1
pnpm -r --if-present typecheck || GATE_OK=0
pnpm test || GATE_OK=0

if [ "$GATE_OK" -ne 1 ]; then
  echo "✗ test gate RED on $BRANCH — do NOT deploy. Inspect the branch / re-run with a human note." >&2
  exit 1
fi
echo "✓ test gate GREEN on $BRANCH"

if [ "${INCIDENT_AUTODEPLOY:-0}" = "1" ]; then
  echo "→ INCIDENT_AUTODEPLOY=1 → committing + reloading services"
  git add -A
  git commit -m "fix(incident): automated remediation ($TS)" >/dev/null 2>&1 || true
  command -v pm2 >/dev/null 2>&1 && pm2 reload all || echo "(pm2 not present — reload skipped)"
  echo "✓ deployed. Review branch $BRANCH and merge to main when satisfied."
else
  echo "Fix is ready on branch '$BRANCH' (tests green). Review the diff, then deploy:"
  echo "    git checkout main && git merge --no-ff $BRANCH && pm2 reload all"
fi
