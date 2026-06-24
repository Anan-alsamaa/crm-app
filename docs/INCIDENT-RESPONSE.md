# Yiji CRM — Incident Response (Claude-driven, no manual code fixes)

The operating rule for this system: **post-deployment issues are never fixed by
hand-editing code.** An incident is routed to **Claude Code**, which understands
the problem from the system's _own_ diagnostic context (logs, health, traces,
recent changes), makes the fix, and proves it with the test suite. A human's job
is to (optionally) describe the symptom and to approve the deploy — not to patch.

This is intentional: fixes are reproducible, test-gated, and captured in git
history instead of ad-hoc edits on a server.

## What you need on the server (once)

- **Claude Code CLI** on PATH (`claude --version`) + `ANTHROPIC_API_KEY` exported.
- Node 20 + pnpm (already required by the deploy), `pm2`, `docker`, `curl`.

## The mechanism

```
scripts/incident/
  detect.sh      fast health gate — exit 1 if anything is wrong (for cron)
  collect.sh     gathers ALL context → scripts/incident/reports/incident-<ts>.md
  remediate.sh   hands the report to Claude → fix on a branch → typecheck + tests
  respond.sh     one command: collect → remediate (the entrypoint)
```

`collect.sh` captures, automatically: service `/health` + `/ready`, PM2 status +
error logs, Docker infra logs (postgres/redis/directus), recent git history, the
list of env keys (values redacted — secrets are never written), and host
resources. That report is what lets Claude diagnose **without** a human
description.

## How to use it

### A. Automatic (preferred) — Claude reacts before you notice

Run the detector on a short interval; when it trips, fire the responder. Add to
the deploy user's crontab:

```cron
# every minute: if unhealthy, auto-route to Claude (logs to a file)
* * * * * cd /opt/yiji/crm-app && scripts/incident/detect.sh >/dev/null 2>&1 || \
  INCIDENT_AUTODEPLOY=0 scripts/incident/respond.sh >> var/incident.log 2>&1
```

With `INCIDENT_AUTODEPLOY=0` (default) Claude produces a **tested fix on a branch**
and stops, so a human approves the reload. Set `INCIDENT_AUTODEPLOY=1` to also
commit + `pm2 reload all` automatically once the tests are green (full
self-healing — enable only once you trust it).

### B. Chat — describe it (or don't) and let Claude work

From the repo on the server:

```bash
scripts/incident/respond.sh "agents get a 403 right after logging in"
# …or, fully automatic (no description):
scripts/incident/respond.sh
```

### C. Interactive — open Claude and use the slash command

```bash
cd /opt/yiji/crm-app && claude
> /incident agents can't see the dashboard
```

`/incident` (defined in `.claude/commands/incident.md`) runs the same
collect → diagnose → fix → test → hand-off flow, conversationally.

## Guardrails (built in)

- Claude works on a `fix/incident-<ts>` branch — never directly on `main`.
- The fix must pass `pnpm -r typecheck` + `pnpm test`; `remediate.sh` re-runs that
  gate independently and refuses to mark a RED branch deployable.
- Claude is instructed to **never** edit `.env*`, print secrets, or run
  destructive/irreversible commands, and to report (not guess) when the cause is
  config/infra rather than code.
- Deploy is the hybrid reload: `git pull` → `pnpm install --frozen-lockfile` (if
  deps changed) → `pm2 reload all` (zero-downtime); rebuild a portal/widget only
  if it changed (`build-frontend.ps1`).

## Notes

- Reports under `scripts/incident/reports/` are gitignored (they contain logs).
- For richer automatic understanding, point `OTEL_EXPORTER_OTLP_ENDPOINT` at a
  collector — traces/metrics make root-causing faster (`collect.sh` already
  captures `/metrics`).
- This complements `deploy/README.md` (how to deploy) — it's how to keep it
  healthy after.
