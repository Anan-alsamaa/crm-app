# Go-live readiness — 2026-06-21

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

**Deploy kit (this pass):** `.env.prod.example` lists every var the prod compose
needs, grouped `[GENERATE]` / `[PROVIDE]` / `[OPTIONAL]`; `scripts/gen-prod-secrets.sh`
emits the strong secrets in one shot. Verified: `docker compose -f
docker-compose.prod.yml config` interpolates cleanly against a fully-populated env
(including the gateway enqueue endpoint + admin `VITE_JOB_PRODUCER_URL` wiring).
Bootstrap idempotence stays CI-gated (`deploy-preflight.yml`); images are built +
pushed by `deploy.yml` (local Docker build is RAM-bound on this box).

## 3. Imports/reports enqueue path — RESOLVED

**Manual Imports & "Run report now" now have a production enqueue path** built
into the socket-gateway (no dev host tool in prod, no extra service).

- The gateway exposes authenticated `POST /jobs/import` + `POST /jobs/report`
  (`services/socket-gateway/src/index.ts` + `queue.ts`). Auth = the caller's
  Directus token, role-gated to `Admin`/`Administrator`; CORS scoped to `/jobs/*`
  via the gateway `CORS_ORIGIN`. Jobs land on the same `imports`/`reports` queues
  the workers consume.
- The admin portal sends the logged-in admin's Directus token as a Bearer
  (`apps/admin-portal/src/lib/job-producer.ts`) and targets `VITE_JOB_PRODUCER_URL`
  — the gateway HTTP URL in prod, the host producer (:3031) in dev (identical
  routes, so **dev is unchanged**).
- Prod wiring is in `docker-compose.prod.yml` (gateway HTTP port published; admin
  portal build arg) + documented in
  [`PRODUCTION.md` → Admin job enqueue](./PRODUCTION.md#admin-job-enqueue-imports--reports).
- _Scheduled_ reports already worked (workers self-schedule) and are untouched.

**Remaining verification (staging, not provable in this RAM-limited dev box):**
smoke-test `POST /jobs/import` + `/jobs/report` against a built gateway image —
expect 401 without a token, 403 for a non-admin token, and `{ ok, jobId }` for an
admin, with the workers then processing the job. Ensure the LB exposes only
`/jobs/*` (+ `/webhooks/*`) publicly and keeps `/metrics` + `/debug/*` internal.

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

### 4b. Required by the latest release (silent no-ops if skipped)

Each of these gates a feature that will _appear_ to work while doing nothing —
none of them fail loudly, so verify them explicitly.

- [ ] **Re-run the Directus bootstrap** (`pnpm --filter directus-bootstrap apply`).
      Adds `tickets.order_snapshot` (JSON), grants `tickets: read` to the
      **svc-socket-gateway** role, and provisions the **compensation ops queue**
      (5 collections + the Agent grants — see below). Without it: ticket order
      cards stay empty, ticket-assignment notifications silently no-op, and
      `/compensation` 403s for every agent. The apply is additive and idempotent
      (it only ever _creates_, never deletes/updates).
- [ ] **Compensation workflow FLOWS are NOT provisioned by the bootstrap.** The
      schema and the Agent permissions now are, so the queue lists and the detail
      page renders — but each action button triggers a Directus **manual flow by
      fixed id** (`directus/compensation-clone/flow-contract.json`), and those
      flows carry the real logic (including the Yiji `AddCoupon` call). Confirm
      the target Directus already owns those 7 flow ids —
      `pnpm --filter directus-bootstrap verify` prints a `WARN` naming any that
      are missing. Never point production at `standin-flows.mjs`: those are
      offline look-alikes that make no external calls.
- [ ] **`VITE_JOB_PRODUCER_URL` for the AGENT portal build** (it was admin-only
      before). Must point at the gateway's HTTP base in prod. If unset the build
      falls back to `localhost:3031` and **assignment notifications quietly do
      nothing**. Set as a Docker build arg — it is baked in at build time, not
      read at runtime.
- [ ] **Password reset needs SMTP on _Directus_** (`EMAIL_TRANSPORT`,
      `EMAIL_SMTP_*`, `EMAIL_FROM`) — separate from the workers' `SMTP_*`.
      Without a mailer the user still sees the neutral "check your email"
      confirmation (deliberate, to prevent account enumeration), so this failure
      is invisible. Verify by actually completing a reset in staging.
- [ ] **`PASSWORD_RESET_URL_ALLOW_LIST`** on Directus must contain BOTH portal
      reset URLs (e.g. `https://agent.example.com/reset-password,https://admin.example.com/reset-password`).
      Directus rejects a `reset_url` that is not allow-listed.
- [ ] SPA rewrite for `/reset-password` on both portals (unknown paths →
      `index.html`), so the emailed link resolves on a cold load.

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
