# Stream A — Infra / Production Readiness

You are the Claude session for this worktree. Read this brief first, then
start work without further confirmation.

## Where you are

- **Worktree**: `D:\emad\Afcoapp\ProgramFile\claudeCode\crm-app-infra`
- **Branch**: `stream/infra` (off `001-yiji-crm-platform`)
- **Integration branch** (where your work eventually merges): `001-yiji-crm-platform`
- **Coordination doc**: [specs/001-yiji-crm-platform/parallel-work-plan.md](./specs/001-yiji-crm-platform/parallel-work-plan.md) — read this before doing anything else.

## What you own — only edit these paths

- `services/**`
- `directus/**`
- root `docker-compose*.yml`
- any `Dockerfile` anywhere
- `.github/workflows/deploy*.yml`
- `docs/PRODUCTION.md`

## What you must NOT edit (other streams own these)

- `apps/**` — Stream B
- `packages/ui/**`, `packages/i18n/**` — Stream B
- `**/tests/**` outside `services/**/tests` — Stream C
- `.github/workflows/ci.yml` — Stream C (you may add `deploy*.yml` only)
- `docs/**` except `PRODUCTION.md` — Stream C
- `README.md`, root `package.json` scripts, `.husky/**`, `vitest.config.ts`, `playwright.config.ts` — Stream C

## Shared territory — escalate before touching

If you need to add a new shared type or change `pnpm-lock.yaml`, **don't do
it on this branch**. Commit it on `001-yiji-crm-platform` first (open a tiny
PR), then rebase this branch and continue.

- `packages/shared-types/**`
- `packages/shared-config/**`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`

## Your work

The 12 concrete tasks are in
[specs/001-yiji-crm-platform/parallel-work-plan.md](./specs/001-yiji-crm-platform/parallel-work-plan.md)
under "Stream A". Read them, then start at #1. Roughly:

1. Multi-stage Dockerfiles for every service
2. `docker-compose.prod.yml` or `k8s/` manifests — pick one
3. OpenTelemetry SDK on all three Node services
4. Prometheus `/metrics` endpoint on each service
5. Postgres backup + restore scripts
6. Document the secrets-management strategy
7. CORS + security headers production audit
8. Real `/ready` checks with downstream pings
9. `.github/workflows/deploy.yml`
10. Zod-validate every required env var; no silent defaults in prod
11. Bootstrap idempotence CI check
12. Rewrite `docs/PRODUCTION.md` as a real runbook

## Done criteria

Stop when:

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` are all green.
- A fresh VM (or k8s namespace) can stand the stack up from your images +
  documented env, and observability shows up in a collector.
- You've opened a PR into `001-yiji-crm-platform` for review.

## Workflow

```powershell
# Before each session of work, sync to latest integration:
git fetch origin
git rebase origin/001-yiji-crm-platform

# Iterate. Push often:
git push -u origin stream/infra

# When a coherent chunk is done, open a PR:
gh pr create --base 001-yiji-crm-platform --head stream/infra
```

## Pinned constraints (do not violate)

- **No new shared types on this branch.** Land them on `001-yiji-crm-platform` first.
- **No commits to `001-yiji-crm-platform` directly** from this worktree. Only PRs.
- **No skipping pre-commit hooks** (`--no-verify`) or pre-push hooks even when impatient.
- **No removing the existing local-dev defaults**: `docker-compose.yml` stays a working local stack. Production lives in `docker-compose.prod.yml` (or `k8s/`) — additive only.
- **Don't commit secrets.** Real values live in env / a secret store; the repo only holds `.env.example` entries + documentation.

## First commands to run

```powershell
pnpm install --frozen-lockfile   # this worktree shares node_modules with main? no — separate install
pnpm typecheck                   # confirm clean baseline before you start
```

When done with the first iteration, read `parallel-work-plan.md` task #1
and start.
