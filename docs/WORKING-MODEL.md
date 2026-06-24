# Yiji CRM — how changes & fixes happen

Maintained through **chat with Claude**: you describe an error or a change, Claude
implements it. The only rule (also in `CLAUDE.md`) is a boundary set by what's
reversible:

|                      | Claude does it…                                                              | Scope                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Technical / code** | **automatically** (implement → typecheck + tests → ship on a `fix/*` branch) | repo changes: logic, tests, types, non-secret config, dependency versions, docs — reversible via git                                                          |
| **Operational**      | **never automatically** — diagnoses and hands you the exact command + why    | service restart/reload (pm2/docker/nginx), containers/volumes, secrets/`.env`/tokens, data/DB/migrations/restores, deploying to the live server, DNS/TLS/host |

So a code fix is auto-written and tested, but **deploying** it (a live `pm2 reload`
/ `git pull` on the server) is operational — that step is always yours.

## Reporting something

- **A new change / feature** → just describe it in chat. Claude builds it.
- **A runtime error** → `/fix "<what's wrong>"` (interactive Claude in the repo).
  It runs `scripts/incident/collect.sh` to auto-capture the system's own context
  (service `/health`+`/ready`, PM2 status + error logs, Docker infra logs, recent
  git history, **redacted** env key names, host resources), diagnoses the root
  cause, then **fixes code automatically / proposes operational steps**.

One entry point, one rule — nothing runs unattended.

## Notes

- `scripts/incident/collect.sh` only _reads_ state and writes a report under
  `scripts/incident/reports/` (gitignored; never contains secret values).
- Deploy procedure: `deploy/README.md`. Stack/architecture: `CLAUDE.md`.
