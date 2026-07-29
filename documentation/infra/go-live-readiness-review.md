# Go-Live Readiness Review — Yiji CRM

**Date:** 2026-06-24
**Method:** Read-only review of the named handover/state docs **cross-checked against live git/branch state** (docs alone were not trusted). No code modified.
**Inputs reviewed:**

- ✅ `frontend-final-handover.md` (crm-app-frontend)
- ✅ `project-bible-draft.md` (crm-app-infra)
- ✅ `security-final-verification.md` (crm-app-infra) + the newer `security-remediation-phase2.md` / `security-merge-readiness.md` that supersede it
- ✅ `current-runtime-state.md` (crm-app-infra)
- ❌ `runtime-reconciliation-plan.md` — **not found in any worktree** (missing input; see Blocker 1)

---

# ⛔ VERDICT: **NOT READY**

The code is feature-complete and the security fixes exist, but **there is no single branch that is simultaneously current, coherent, and secure**, the environment is a **local dev rehearsal** (ngrok free tunnel + Vite dev + `0.0.0.0` binds, no TLS/DNS), and rollback/monitoring are not established. Multiple foundational blockers remain.

| Dimension         | Status                   |
| ----------------- | ------------------------ |
| 1. Security       | ❌ Not ready             |
| 2. Infrastructure | ❌ Not ready             |
| 3. Frontend       | ⚠️ Ready with conditions |
| 4. Database       | ❌ Not ready             |
| 5. Operational    | ❌ Not ready             |
| 6. Rollback       | ❌ Not ready             |
| 7. Monitoring     | ❌ Not ready             |

---

## Per-dimension assessment

**1. Security — ❌.** All 7 socket-gateway hardenings are implemented on `fix/socket-idor-typing-read-phase2` (`73717ea`, gates green) but it is **local-only, not pushed, not merged**. Ground-truth grep of the deployable branches:

- `origin/001` (GitHub default / documented source-of-truth): **0/7** guards present (message:send, typing, read:ack, decode all absent; only `csat` survived). Deploying 001 ships every IDOR.
- `origin/main` (what's actually running): **6/7** — has message:send/typing/read:ack IDOR guards + `sanitizeFilename`, but **`decodeUploadContent` is absent** (upload-corruption bug live).
- Open decisions (not code): **#5** `WIDGET_CORS_ORIGIN='*'` prod-wildcard exemption; **#7** customer-jwt phone-only narrowing.

**2. Infrastructure — ❌.** Per `current-runtime-state.md` (verified live): the stack is a **hybrid rehearsal** spanning three branches (`main` backend+portals, `001` infra config, `fix/e2e-tickets-first-response` widget). The widget is served from a **Vite dev server via an ngrok _free_ tunnel**; portal Vite dev servers are down and the served static bundles are **stale** (built 2026-06-23 16:38, before `main` HEAD). `8081` (gateway http) and `8085` (ai-gateway) bind **`0.0.0.0`**, not loopback. The running nginx is `nginx.local.conf` (static only, **no** TLS/reverse-proxy) — the prod edge `deploy/nginx/yiji-crm.conf` is not in use. No domain, no certbot.

**3. Frontend — ⚠️.** Code quality is high (strict TS, cookie auth H-2, code-split, no TODO/mock-in-prod). Deployable via `bash deploy/build-frontend.sh` (strips the widget demo page). Conditions: rebuild from a coherent branch (current bundles are stale); **no build-time secret guard** (could bake `VITE_WIDGET_JWT_SECRET`/`VITE_JOB_PRODUCER_TOKEN` into the client); chat-widget has no unit tests; cross-portal duplication (drift risk, non-blocking).

**4. Database — ❌.** Bootstrap is idempotent and CI-gated (good). But: single **Docker** Postgres (no managed/HA instance), `scripts/backup-pg.sh`/`restore-pg.sh` exist yet there is **no scheduled/offsite/verified restore**, and the schema is **forward-only** (no down-migrations → schema rollback = restore-from-backup, untested). Missing indexes on hot filter columns (`tickets.status`, `*.assigned_agent`, `conversations.{vendor,status}`) will degrade under real volume.

**5. Operational — ❌.** A runbook exists (`deploy/README.md`), but production prerequisites are unmet: secrets not rotated and stored **plaintext on disk** (no secret manager), no DNS/TLS, SMTP/Gemini/managed-Redis not provisioned, and no staging sign-off. The running PM2 config is not the documented hybrid file (`workers` health port `8083` documented but **unset live**).

**6. Rollback — ❌.** No blue-green or documented rollback procedure for the hybrid. With deployment split across three branches and stale bundles, "roll back to what" is ambiguous. DB restore path exists but is untested. Code revert is possible (merge-commit convention) but not exercised.

**7. Monitoring — ❌.** `/health` exists on Directus/gateway/ai-gateway (workers health **not** exposed). OpenTelemetry is wired but **no-op by default** (no OTLP endpoint set). No dashboards, no alerting, no on-call, no SLOs, no log aggregation/retention defined.

---

# BLOCKING ITEMS (production go-live)

1. **No secure, current, single deployable branch.** `001` (default/source-of-truth) is **0/7 on security**; `main` (running) is **6/7** (missing `decodeUploadContent`) and has **forked from 001** (28 ahead / 16 behind — neither is a superset); the complete fix (`fix/socket-idor-typing-read-phase2` `73717ea`) is **unpushed/unmerged**. → Reconcile `main`↔`001` into one branch, merge the security fix, and make that the single deploy source. _(The missing `runtime-reconciliation-plan.md` is presumably meant to define this — it does not exist.)_

2. **Security fix is not live and two findings are undecided.** Even after merge to `001`, the running system serves from `main` and must be rebuilt/redeployed to get the fix. Resolve **#5** (`WIDGET_CORS_ORIGIN='*'`) and **#7** (customer-jwt phone-only) explicitly before cutover.

3. **Not served as production.** The customer widget runs on a **Vite dev server behind an ngrok free tunnel**; portals serve **stale** static bundles; gateway-http/ai-gateway bind **`0.0.0.0`**. → Build prod bundles, serve via the prod nginx edge (`deploy/nginx/yiji-crm.conf`), bind app services to loopback, retire ngrok/Vite-dev.

4. **No TLS / domain / WSS.** No real domain, no certbot certificates, no HTTPS, no WSS-with-sticky-sessions for Socket.IO. → Provision DNS for the 6 subdomains + certbot; terminate TLS at the edge.

5. **Secrets not production-hardened.** Plaintext on disk, not rotated, no secret manager; **no build-time guard** preventing a real secret from being baked into the client bundle. → Rotate all secrets, move to a secret store, set `CORS_ORIGIN` to exact hostnames, add the client-bundle secret guard.

6. **Database not production-grade.** No managed/HA Postgres; **no scheduled, offsite, restore-tested backups**; missing hot-path indexes. → Stand up managed (or HA) Postgres, automate + test backups/restore, add the indexes.

7. **No monitoring or alerting.** OTel is no-op; no dashboards/alerts/on-call/SLOs; workers health port not exposed. → Wire an OTLP endpoint, expose the workers health port, add health/queue-depth/error-rate alerts and a log sink.

8. **No established rollback.** → Define and **rehearse** a rollback (previous build artifact + DB restore), tied to the single deploy branch from Blocker 1.

9. **Pre-cutover gates not run on staging.** E2E is non-blocking/dispatch-only and the load test hasn't run against staging; no staging sign-off. → Run Playwright E2E + load test on a production-like staging environment and record a sign-off (`docs/GO-LIVE-READINESS.md`).

---

## Path to "READY WITH CONDITIONS"

The fastest credible route: (1) decide #5/#7; (2) create the missing reconciliation plan, converge `main`+`001` into one branch and merge `73717ea`; (3) provision a real host + managed Postgres/Redis + DNS/TLS; (4) rotate secrets + add the bundle secret guard; (5) build prod artifacts and serve via the prod nginx edge with loopback binds (no ngrok/Vite-dev); (6) wire monitoring/alerting + backups + a rehearsed rollback; (7) pass E2E + load on staging and sign off. Blockers 1–2 are the prerequisites everything else depends on.

---

_Read-only review. No source modified. Branch facts verified live: `origin/main` `d1f210d`, `origin/001` `ef31b01`, fix `73717ea` (local), widget on `fix/e2e-tickets-first-response`. 2026-06-24._
