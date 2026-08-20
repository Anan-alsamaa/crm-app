<!-- SPECKIT START -->
Active feature: **Yiji CRM** (`001-yiji-crm-platform`).
Read the current plan and design artifacts before working:
- Plan: `specs/001-yiji-crm-platform/plan.md` (stack, structure, gates)
- Spec: `specs/001-yiji-crm-platform/spec.md`
- Research: `specs/001-yiji-crm-platform/research.md`
- Data model: `specs/001-yiji-crm-platform/data-model.md`
- Contracts: `specs/001-yiji-crm-platform/contracts/`
- Quickstart: `specs/001-yiji-crm-platform/quickstart.md`

Stack (non-negotiable): pnpm monorepo, TypeScript strict; Directus + Postgres + Redis;
Socket.IO (Redis adapter) gateway; BullMQ workers; AI gateway → Gemini (PII redacted,
swappable provider); React 18 + Vite portals + Preact widget; Tailwind, TanStack Query,
RHF + Zod, i18next (EN/AR RTL). Delivered in 6 phases.
<!-- SPECKIT END -->

## When something says "failed to fetch"

Run `pwsh ./check-stack.ps1` FIRST. It checks Docker, PM2, every port and the
health endpoints, repairs what it can, and names anything still down.

PM2 on Windows loses its **entire process list** when its daemon dies — a
reboot, a wedged Docker, or the box running out of memory during a build. The
portals keep working, because nginx serves the built files from disk and has no
idea the services are gone. Only the things that call a gateway break: the AI
panel and the order lookup, both with "failed to fetch". That symptom has been
diagnosed from scratch more than once; the script is the diagnosis, and it runs
`pm2 save` on the way out so the next daemon death is one command to undo.

## How changes & fixes happen (working model)

This project is maintained through chat with Claude — you describe an error or a
change, Claude implements it end-to-end. Claude's autonomy is bounded by what is
reversible:

- **Technical / code work → Claude does it automatically.** Anything in the repo:
  bug fixes, features, refactors, tests, types, non-secret config, docs, dependency
  versions. Claude implements it, runs `pnpm -r --if-present typecheck` + `pnpm test`,
  and ships it on a branch (or main) — reversible via git. No step-by-step approval.

- **Operational actions → Claude NEVER does them automatically.** Anything on the
  running system: restarting/reloading services (pm2, docker, nginx), containers or
  volumes; secrets / env / tokens (`.env*`); data (DB, uploads, migrations, restores);
  deploying to the live server; DNS / TLS / host / OS. For these Claude diagnoses and
  hands over the exact command(s) + why — it does **not** run them. The human executes
  (or explicitly says "go" for one specific action).

Consequence: a code fix is auto-implemented and tested, but *deploying* it (a live
`pm2 reload` / `git pull` on the server) is operational and stays the human's step.
To report a runtime problem use `/fix` (it auto-gathers system context); for a new
change, just describe it. See `docs/WORKING-MODEL.md`.
