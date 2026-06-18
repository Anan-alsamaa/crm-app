# Go-live readiness — 2026-06-18

A current-state assessment to run **before scheduling a production cutover**. The
timeless "how to deploy/operate" reference is [`PRODUCTION.md`](./PRODUCTION.md)
(topology, images, env guards, secrets, observability, backups, scaling, runbook).
This file is the _snapshot_: what's verified today and what still blocks go-live.

## 1. Quality gate — GREEN

Run from the repo root (`pnpm -r --workspace-concurrency=1 …` on RAM-constrained hosts):

| Gate                               | Result                               |
| ---------------------------------- | ------------------------------------ |
| `pnpm typecheck`                   | ✅ 11/11 packages                    |
| `pnpm lint`                        | ✅ clean                             |
| unit tests (agent + admin portals) | ✅ 134 + 71 pass                     |
| `pnpm build`                       | ✅ all 11 packages emit prod bundles |

> Services + shared packages are additionally typechecked/tested in CI
> (`.github/workflows/ci.yml`).

## 2. Production infra — present and matches the runbook

Verified to exist in the repo: `docker-compose.prod.yml`, per-service Dockerfiles
(`services/{socket-gateway,ai-gateway,workers}/Dockerfile`), portal Dockerfiles,
CI `deploy.yml` (build + push to GHCR) and `deploy-preflight.yml` (bootstrap
idempotence on a fresh DB), `scripts/backup-pg.sh` / `restore-pg.sh`. Each Node
service ships Zod env guards (fail-fast), `/health` + `/ready` + `/metrics`, and
OpenTelemetry. **The platform is production-engineered.**

## 3. Blocking gap — resolve before cutover

**Manual Imports & "Run report now" have no production enqueue path.** _(owners: infra + frontend)_

- The admin portal's Imports and Reports pages post to `VITE_JOB_PRODUCER_URL`
  (`apps/admin-portal/src/lib/job-producer.ts`), which targets
  `crm-app-infra/tools/job-producer` — a **dev host tool**. It is **not** in
  `docker-compose.prod.yml`, the runbook, or CI.
- What still works in prod without it: **scheduled reports** (the workers
  self-schedule via `syncScheduledReports`) and the workers _consuming_ the
  `imports`/`reports` queues. What breaks: the **manual** "Import CSV" submit and
  the **"Run report now"** button — nothing enqueues those jobs in prod.
- Decide one before launch:
  - **(a)** Containerize `job-producer` as a service in `docker-compose.prod.yml`
    (set `PRODUCER_TOKEN`, bake `VITE_JOB_PRODUCER_URL` + `VITE_JOB_PRODUCER_TOKEN`
    into the admin-portal build, document it in `PRODUCTION.md`), **or**
  - **(b)** Fold enqueue into an existing authenticated surface — a small endpoint
    on the socket-gateway, or a Directus flow/operation — and drop the standalone
    service. Fewer moving parts; **recommended.**

## 4. Standard cutover checklist

All covered by [`PRODUCTION.md` → Security checklist](./PRODUCTION.md#security-checklist);
the high-risk items to not miss:

- [ ] Rotate **every** secret — `DIRECTUS_ADMIN_PASSWORD` (dev = `123456`),
      `DIRECTUS_KEY`/`SECRET`, `SVC_*` tokens, `YIJI_JWT_SECRET` (≥ 32 chars),
      `DB_USER`/`DB_PASSWORD` (off `directus`/`directus`). Inject from a secret store.
- [ ] `NODE_ENV=production` on the three Node services (activates the guards).
- [ ] `CORS_ORIGIN` = exact portal hostnames (the prod guard rejects `*`).
- [ ] TLS in front of every HTTP service; WebSockets over **WSS** with sticky
      sessions; **CSP + HSTS** at the portal/widget CDN layer.
- [ ] `SMTP_*` set (workers refuse to boot in prod without `SMTP_HOST`).
- [ ] Managed Postgres + Redis on private networks; nightly `backup-pg.sh` +
      **quarterly restore drill**.
- [ ] `GEMINI_API_KEY` set (else AI endpoints degrade to `503 not_configured`).

## 5. Pre-launch verification (against staging, not prod)

- [ ] `pnpm test:e2e` (Playwright) — full agent/admin/widget flow.
- [ ] Load test: `crm-app-infra/tools/load-test` against the staging gateway —
      validate the concurrent-customer target with the Redis adapter + scaled
      `socket-gateway`/`workers`.
- [ ] Bootstrap idempotence: `deploy-preflight` (apply twice on a fresh DB).
- [ ] Smoke: each service `/ready` → 200; widget connects; a customer message
      reaches all agents in realtime; an SLA timer fires.

## 6. Owners (cross-stream)

| Stream       | Responsibility                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| **infra**    | prod compose / images / CI, the §3 job-producer decision, managed PG + Redis, secret injection, TLS/LB |
| **frontend** | `VITE_*` build args, the job-producer client if the §3 path changes                                    |
| **quality**  | e2e + load-test sign-off, restore-drill verification                                                   |
