# Go-live readiness — 2026-08-21 (coupon section updated 2026-08-30)

A current-state assessment to run **before scheduling a production cutover**. The
timeless "how to deploy/operate" reference is [`PRODUCTION.md`](./PRODUCTION.md)
(topology, images, env guards, secrets, observability, backups, scaling, runbook).
This file is the _snapshot_: what's verified today and what still blocks go-live.

## 1. Quality gate — GREEN

Run from the repo root (`pnpm -r --workspace-concurrency=1 …` on RAM-constrained hosts):

| Gate                            | Result                                       |
| ------------------------------- | -------------------------------------------- |
| `pnpm verify` (the 9-step gate) | ✅ all 9 steps                               |
| `pnpm typecheck`                | ✅ every package                             |
| `pnpm lint`                     | ✅ clean                                     |
| unit — services + packages      | ✅ 733 pass · 81.1% lines                    |
| unit — agent portal             | ✅ 470 pass · 62.9% lines                    |
| unit — admin portal             | ✅ 390 pass · 69.6% lines                    |
| unit — chat widget              | ✅ 81 pass · 76.6% lines                     |
| `pnpm test:e2e`                 | ✅ 13 pass, 1 opt-in skip (`E2E_COMMERCE=1`) |
| `pnpm build`                    | ✅ every package emits a prod bundle         |
| `pnpm check:advisories`         | ✅ every locked version outside its range    |

> CI runs the same gates on every push to `main`
> (`.github/workflows/ci.yml`) and is **green**. The e2e job blocks the run —
> it is deliberately NOT `continue-on-error`, which is how three specs once
> rotted for weeks behind a green tick.
>
> CI serves the portals from `vite dev`, this machine serves them built behind
> nginx, so the job declares its own URLs (`E2E_BASE_URL`, `E2E_ADMIN_URL`,
> `E2E_WIDGET_URL`). Any new environment has to do the same.

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

- [ ] **Staff sign-in by employee ID needs the bootstrap.** `apply.ts` adds
      `directus_users.login_name` and `.contact_email`. Without them the Users
      form cannot save a login name and NOBODY CREATED AFTER THE CUTOVER CAN
      SIGN IN — the identity is minted from a field that does not exist.
- [ ] **Move existing staff across**: `node scripts/migrate-staff-logins.mjs`
      (dry-run first). It gives each agent account a login name and rewrites its
      identity to `<login>@staff.example.com`, leaving passwords, the
      administrator, the service accounts and the e2e runner untouched. Skip it
      and those people keep signing in with their old email address, which
      works but is not what anyone was told to expect.
- [ ] **`YIJI_COUPON_DELIVERY` — the one switch that spends real money.**

      `off` (the default, and what `.env.prod.example` ships) means approved
      coupons queue up and go nowhere. `on` means the worker pushes them to Yiji,
      Yiji notifies the customer, and the customer can spend them. There is no
      undo: deleting the CRM row does **not** revoke the grant on Yiji's side.

      - **Staging: leave it `off`, permanently.** Staging shares the real Yiji
        tenant, so `on` there hands real customers real money for test data.
      - **Production: turn it on only when you are ready to be sending.** The
        sweep runs every 5 minutes and will deliver *everything* currently
        sitting at `approved` — check what that is first:

        ```sql
        SELECT coupon_code, coupon_value FROM coupon_approvals
        WHERE status IN ('approved','edited') AND yiji_coupon_user_id IS NULL
          AND yiji_push_error IS NULL AND delivery_excluded IS NOT TRUE;
        ```

        Anything in that list you do not want sent should be marked
        `delivery_excluded = true` **before** flipping the switch.

- [ ] **Yiji credentials must reach the WORKERS service**, not just the gateway.
      `YIJI_ADMIN_API_URL`, `YIJI_ADMIN_EMAIL`, `YIJI_ADMIN_PASSWORD`,
      `YIJI_TENANT_ID` and `YIJI_COUPON_DELIVERY` are all wired through in
      `docker-compose.prod.yml` — verified. Without them the coupon feature
      ships dead: the push cannot authenticate and every coupon sits `approved`
      with no error, which looks exactly like nobody having approved anything.

- [ ] **The coupon-integration migrations (added 2026-08-26 → 08-30).** Four
      scripts, each **idempotent** — re-running one prints "nothing to do" — so
      run them in any order and again if unsure. All take `DIRECTUS_TOKEN` (or
      `DIRECTUS_ADMIN_EMAIL` + `DIRECTUS_ADMIN_PASSWORD`) and are dry-run by
      default; add `--write` to apply.

      | script | what it does | if you skip it |
      | --- | --- | --- |
      | `add-coupon-item-sku.mjs` | adds `coupon_approvals.item_sku` | item-level reporting stays a text search across spellings |
      | `add-coupon-no-other-discounts.mjs` | adds `coupon_approvals.no_other_discounts` | the agent's stacking choice has nowhere to persist; the push reads `undefined` and sends the permissive default |
      | `migrate-issuing-sides.mjs` | Call Centre → Customer Care; retires "Delivery"; adds the five couriers | coupons carry the wrong `issuingSideId` and Yiji attributes the cost to the wrong department |
      | `migrate-service-types.mjs` | Drive Thru → Carhop, Dinning → Dine-in, TakeOut → Takeout, **and the tickets already holding the old spellings** | the combobox is locked to the list, so those tickets render blank and lose their service type on the next save |

      The last two touch DATA as well as lists, which is why they move the rows
      in the same pass — renaming a list alone orphans every row pointing at it.

- [ ] **Seed the option lists**: `node scripts/seed-option-lists.mjs --write`.
      Adds the `ai_action` list ("Inbox: AI assistance"). An unreadable or empty
      list falls back to offering every action, so this fails soft — but the
      operator cannot turn any of them off until it is seeded.

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
- [x] **Password reset SMTP on _Directus_ — now wired in the prod compose.**
      Until 2026-07-29 neither `EMAIL_*` nor `PASSWORD_RESET_URL_ALLOW_LIST`
      appeared in `docker-compose.prod.yml` at all, so setting them in
      `.env.prod` (as this checklist told you to) did nothing — the values never
      reached the container. Directus uses `EMAIL_*` names while the workers use
      `SMTP_*`; the compose now maps the workers' `SMTP_*` onto Directus, so a
      mailer is configured ONCE. `EMAIL_SMTP_HOST` is required (`:?`), matching
      how the workers already fail fast.
      Still verify by completing a real reset in staging: without a mailer the
      user sees the neutral "check your email" confirmation regardless
      (deliberate, to prevent account enumeration), so a broken mailer is
      invisible from the UI.
- [ ] **`PASSWORD_RESET_URL_ALLOW_LIST`** must list BOTH portal reset URLs
      (`https://agent.example.com/reset-password,https://admin.example.com/reset-password`).
      Now passed through by the compose and REQUIRED (`:?`), so Directus will
      refuse to start rather than silently reject the emailed link — but the
      value itself is still yours to set correctly.
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
