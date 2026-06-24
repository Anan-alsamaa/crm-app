---
description: Diagnose a production incident from the system's own context and fix it (no manual code edits)
argument-hint: [optional description of the symptom]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

A production incident has been raised on the Yiji CRM. Resolve it end-to-end —
the operator does **not** edit code; you do.

Optional operator description: $ARGUMENTS

## 1. Gather the system's own context (don't rely on the description alone)
Run the collector and read its report:

!`INCIDENT_NOTE="$ARGUMENTS" scripts/incident/collect.sh`

Read the report it printed (the newest file in `scripts/incident/reports/`), plus
pull anything else you need: `pm2 logs <svc> --lines 200 --nostream`,
`docker compose -f deploy/docker-compose.infra.yml logs --tail 200 <svc>`, service
`/health` `/ready` `/metrics`, and `git log`/`git diff` around recent changes.

## 2. Diagnose
State the **root cause** explicitly before changing anything. The most recent
commits (in the report) are the usual suspect for a regression.

## 3. Fix
- Make the **minimal, targeted** code change. No unrelated refactors.
- If the cause is config / secrets / infra (not code), DO NOT invent a code
  change — tell the operator exactly what to set or restart.
- Never touch `.env*` or print secrets. Never run destructive/irreversible
  commands (db drops, `rm -rf`, force-push, history rewrite).

## 4. Prove it
Run `pnpm -r --if-present typecheck` and `pnpm test`. They must pass before you
present the fix. If you can't get green, stop and report what's blocking.

## 5. Hand off
Summarize: root cause → fix → files changed → test results → the exact deploy
command (hybrid: `git pull` on the server, `pnpm install --frozen-lockfile` if
deps changed, `pm2 reload all`; rebuild a portal/widget only if it changed).
Commit the fix on a `fix/incident-*` branch; leave merging to main to the operator
unless told otherwise.
