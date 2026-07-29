# Yiji CRM — Complete Session Memory Export

**Exported:** 2026-06-24
**Project:** Yiji CRM (`001-yiji-crm-platform`)
**Repo:** github.com/Anan-alsamaa/crm-app · git user `CodeByEmad` · operator `r.obeid@anan.sa`
**Purpose:** Durable record of everything material accumulated across this session's full lifetime. Assume the live session is deleted after this export; treat this file as the only surviving context.

> ⚠️ **Read this first.** The single most important fact in this document: the convergence of the three work streams into `001` is **NOT clean** — `stream/frontend` is not an ancestor of `001`, and security hardening that exists on the streams is **missing from the deployable `001` branch**. Several "merged and green" PRs did not land the code they appeared to. Verify the actual `001` state before trusting any prior "done." See §2, §3, §6, §13, §14.

---

## 0. What this project is (orientation)

A pnpm/TypeScript monorepo CRM ("Yiji CRM"):

- **services/** — `socket-gateway` (Socket.IO realtime + an HTTP app on PORT+1 for `/health`,`/jobs`,`/webhooks`), `ai-gateway` (Gemini, PII-redacted, swappable provider), `workers` (BullMQ consumers).
- **packages/** — `shared-config` (env, Directus clients, auth), `shared-types` (Zod entity schemas, Yiji commerce client), `ui` (React component library), `i18n` (EN/AR RTL).
- **apps/** — `agent-portal`, `admin-portal` (React 18 + Vite SPAs), `chat-widget` (Preact embeddable widget).
- **directus/bootstrap/** — idempotent schema/roles/permissions/seed apply for Directus 11.
- **deploy/, docs/, tools/** — ops.
- Backing services: Directus 11 + Postgres + Redis. AI via Gemini. Realtime via Socket.IO (Redis adapter). Jobs via BullMQ.

Delivered in 6 phases across three parallel work "streams": **Stream A (infra/backend)**, **Stream B (frontend)**, **Stream C (quality/security)**. They integrate into branch **`001-yiji-crm-platform`**.

---

## 1. Architectural decisions made

1. **Integration branch is `001-yiji-crm-platform`, not `main`.** All streams merge here via PR; this is the deployable source of truth. (`main` exists but is not the working integration line.)
2. **Final deployment topology (user-decided, authoritative):**
   - **Docker** for the infra tier: Postgres 16/17, Redis 7, Directus 11 — bound to **loopback only** (`127.0.0.1`), Postgres with no host port.
   - **PM2** for the Node tier: `socket-gateway`, `ai-gateway`, `workers` — run natively via `tsx` from `ecosystem.config.cjs`.
   - **nginx** as the edge: serves the two operator SPAs + the embeddable widget as static files and reverse-proxies `api.`/`ws.`/`ai.` to the loopback services, with TLS via **certbot**.
   - Files: `deploy/docker-compose.infra.yml`, `ecosystem.config.cjs`, `deploy/nginx/yiji-crm.conf`, `deploy/README.md` (the canonical runbook).
3. **Auth = Directus cookie mode (security item H-2).** Refresh token in an httpOnly/Secure/SameSite cookie; access token in memory only (no localStorage). `packages/shared-config/src/auth.ts` uses `authentication('cookie', {credentials:'include'})`; portals send credentials; Directus configured `CORS_CREDENTIALS=true`, `REFRESH_TOKEN_COOKIE_SAME_SITE=lax`, `REFRESH_TOKEN_COOKIE_SECURE=true`.
4. **No service tokens in the browser (C-1/C-2).** The AI gateway verifies the _caller's_ Directus session (`/users/me` whoAmI + `/roles` for admin role ids) and derives `userId`/`isAdmin` server-side. Commerce calls go through an ai-gateway `/commerce/*` proxy using the session token. Portals ship **no** `VITE_AI_SVC_TOKEN`/`VITE_YIJI_API_*`.
5. **Admin gating by Directus `admin_access` policy, not role name.** `AuthUser.admin_access` is computed from role+direct policies (Directus 11 model); role-name allowlist kept only as fallback.
6. **Compose `app` profile for hybrid local dev (PR #33).** `docker-compose.yml` gates the three Node services behind `profiles: ['app']`, so a bare `docker compose up -d` starts **infra only** (postgres/redis/directus) and the Node tier runs under PM2 without a port clash. Full all-Docker stack on demand: `docker compose --profile app up -d`.
7. **Frontend built from the single self-contained `001` checkout on Linux** via `deploy/build-frontend.sh` (PR #31), which also **strips the widget demo host page** from the bundle.
8. **Firecrawl = cloud CLI, not self-hosted Docker** (user decision): use the global `firecrawl-cli` against the cloud API; the multi-service Docker self-host was removed.

---

## 2. Decisions later reversed (within this session)

1. **PR #34 (a `node` compose profile) — created then CLOSED as redundant.** I built a fix to gate the Node services behind a `node` profile to stop orphaned image rebuilds. While pushing it I discovered `001` **already** had the same fix under an `app` profile (PR #33, commit `93c1358`). Root cause: my **local `crm-app-infra` checkout was stale** (on `deploy/linux-build-frontend`, pre-#33). I closed #34 and synced local to `origin/001` instead. **Lesson:** check whether `001` already solves it before building a fix (see §13).
2. **`git checkout --theirs auth.ts` during the frontend merge — reversed by hand.** Taking 001's `auth.ts` wholesale silently dropped the frontend's `admin_access` work (001 had cookie mode but not `admin_access`; frontend had `admin_access` but not cookie mode). I had to hand-write the **combined** version (cookie mode + admin_access). **Lesson:** never blind `--ours`/`--theirs` on a file that needs a 3-way combine.
3. **Belief that taking frontend's `connection.ts` (`--ours`) preserved the gateway security guards — later proven false.** During the frontend merge I concluded frontend's `connection.ts` (with the `message:send` IDOR guard at ~line 379 and `decodeUploadContent`/`sanitizeFilename`) was the secure superset and merged it. The later risk assessment found the **deployable `001` `connection.ts` lacks all of these** (handler at `connection.ts:268`, no binding guard). This is the most consequential reversal: the security posture I reported as preserved is **not** present on `001`. (See §6, §13.)

---

## 3. Important discoveries

1. **`stream/frontend` is NOT an ancestor of `origin/001`** (`git merge-base --is-ancestor` returns false) despite PR #29 showing "merged." Convergence is not clean; some stream work is absent from `001`.
2. **The converged `001` gateway is missing security hardening that exists on the streams.** Verified by direct read: `services/socket-gateway/src/connection.ts:268` (`message:send`) persists + broadcasts to the **client-supplied** `conversationId` with no check binding it to the authenticated socket; no `decodeUploadContent`/`sanitizeFilename`. The CSAT handler at `:490` _is_ bound — proving the pattern was known but not applied to `message:send`.
3. **`GEMINI_MODEL` default is the retired `gemini-1.5-flash`** (`ai-gateway/src/config.ts:16`, `docker-compose*.yml`) → 404 on every AI call unless overridden. PM2 (`ecosystem.config.cjs:82`) uses `gemini-2.5-flash`, so Docker and PM2 run different models.
4. **`GatewayDirectus.upsertContact` returns an object `{id,isNew,name,phone}`, not a string id.** This caused 5 "failing" socket-gateway tests after the infra merge — they were **pre-existing test drift** (tests expected a string), not a regression I introduced.
5. **Two production architectures ship side-by-side.** The "final" PM2+nginx model (`deploy/README.md`) coexists with an older all-Docker + **Caddy** model (`docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/docker-compose.proxy.yml`, portal `Dockerfile`s, `docs/{DEPLOYMENT,PRODUCTION,LOCAL_PROD,GO-LIVE-READINESS}.md`). The ai-gateway port is documented **three** ways: 8081 (code/Docker), 8085 (PM2/real), 8091 (LOCAL_PROD).
6. **`build-frontend.ps1` leaks `YIJI_JWT_SECRET`.** It regenerates the widget host page and bakes the real signing secret into a client-served `index.html` (anyone could mint customer tokens). It also assumes a _sibling_ `crm-app-frontend` repo. It is a Windows local-demo helper only; `deploy/build-frontend.sh` is the safe prod path.
7. **The widget demo page signs with `VITE_WIDGET_JWT_SECRET ?? 'dev-yiji-secret'`** (`apps/chat-widget/src/demo.ts`); the default build emits this `index.html` — harmless only because `build-frontend.sh` deletes it.
8. **This machine is running the live demo stack** (Docker infra `crm-app-infra-*` + PM2 Node services + `yiji-portals` nginx). Its volumes `crm-app-infra_{postgres_data,directus_uploads,redis_data}` hold seeded demo data that must be preserved.
9. **CI quietly does not gate on E2E.** The Playwright job is `if: workflow_dispatch` **and** `continue-on-error: true` — it can never turn CI red (PR #21 defanged it to stop failure emails).

---

## 4. Assumptions currently relied upon

1. `001-yiji-crm-platform` is the deployable source of truth. (Caveat: it is missing some hardening — §3.)
2. The live `crm-app-infra` Docker stack and its `crm-app-infra_*` volumes are **production-like demo data** — do not delete/recreate them; **never run E2E against the demo Directus on `:8055`** (it pollutes seeded data). E2E only runs in CI against an ephemeral stack.
3. `SVC_AI_TOKEN` is **reused, not rotated** (explicit user decision — "use the same AI api key").
4. The real ai-gateway port in the running/PM2 setup is **8085** (env override of the 8081 code default).
5. `GEMINI_MODEL` must be **explicitly set** to a current model in every environment; the code/Docker default is broken.
6. `docker compose up -d` inside `crm-app-infra` brings up **infra only** (the `app` profile gates the Node tier).
7. The 544 unit tests + 14 E2E being green reflects the converged apps/workers — but **green tests do not cover the `message:send` IDOR**, so "all green" did not (and does not) imply the gateway is hardened.
8. Firecrawl is available via the global `firecrawl` CLI (cloud API), not Docker.

---

## 5. Known technical debt

- **Repository drift across three clones/branches** (the root structural debt — §10).
- **Duplicate code:** `isPlaceholder` (all 3 services' `config.ts:5`), Directus error-extraction (`apply.ts:48` / `connection.ts:63` / `notifications.ts:69`), browser bearer-fetch wrapper (4 portal clients). Should live in `@yiji/shared-config` / a shared client.
- **Dead/superseded code:** `docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/docker-compose.proxy.yml`, `apps/*/Dockerfile`, `tools/{bull-board,job-producer,load-test,screenshot}` (with committed `node_modules` + `*.out` logs), `scripts/shot-*.mjs`/`inspect-login-btn.mjs`, `packages/shared-config/src/env.ts:redisUrlSchema` (unused export), `.gitignore.resolved` (0 bytes), the `notImplemented` factory in `workers/.../processors/index.ts`.
- **Test gaps:** `directus/bootstrap` (no tests), `packages/ui` (Storybook only), `apps/chat-widget` (no unit tests); E2E non-blocking.
- **Data-tier debt:** missing indexes on `tickets.status`, `*.assigned_agent`, `conversations.{vendor,status}`; pervasive `limit:-1` full-collection reads in workers reports + portal list APIs; portals use `new QueryClient()` with no defaults (`staleTime:0` + refetch-on-focus → refetch storms).
- **Build debt:** `tsc -b` + `noEmit:true` (non-standard), no `manualChunks` (>500 KB SPA chunk), Windows/Linux build scripts diverge.

A full, file-line-referenced catalog exists at **`documentation/project-risk-assessment.md`** (created this session).

---

## 6. Known bugs (verified or strongly evidenced this session)

| Severity | Location                                        | Bug                                                                                                                                                           |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟠 High  | `ai-gateway/src/config.ts:16` + compose         | `GEMINI_MODEL` default `gemini-1.5-flash` is retired → 404 on every AI call unless overridden.                                                                |
| 🟠 High  | `socket-gateway/src/connection.ts:268`          | `message:send` write-IDOR — no binding of client `conversationId` to the authenticated socket (verified by direct read).                                      |
| 🟠 High  | `workers/src/processors/notifications.ts:43-66` | Email "delivered" timestamp written **before** the send is attempted.                                                                                         |
| 🟡 Med   | `workers/src/lib/sla-clock.ts:26-41`            | Business hours computed in UTC, ignoring `BusinessHours.timezone` (wrong for `Asia/Riyadh` etc.).                                                             |
| 🟡 Med   | `workers/src/processors/sla.ts`                 | SLA warning/breach re-fires every 60 s (`removeOnComplete:true` + no dedup).                                                                                  |
| 🟡 Med   | `socket-gateway/src/connection.ts:~338`         | Live attachment upload uses raw `Buffer.from(...buffer)` (ignores byteOffset/length) and never sanitizes the filename — bypasses the corruption-safe helpers. |
| 🟡 Med   | `ai-gateway/src/ratelimit/index.ts:96-102`      | Monthly cap `INCR`-then-`DECR` non-atomic; TTL set only when `used===1` → possible immortal counter key.                                                      |
| 🟡 Med   | `agent-portal/.../ConversationView.tsx:352-368` | Optimistic agent reply never rolls back on send failure (stuck "pending" forever).                                                                            |
| 🟡 Med   | `socket-gateway/src/index.ts:247,257`           | `/jobs/*` admin gate matches role by display-name string (rename locks out admins; a role literally named "Admin" passes).                                    |
| ⚪ Low   | `ai-gateway/src/provider/gemini.ts:64`          | Error status regex only matches bracketed codes → the model-404 isn't classified/retried.                                                                     |

(One bug was **fixed** this session: the Gemini quota-error regex didn't match `"Quota exceeded for this project"` → widened to include `quota exceeded`.)

---

## 7. Known deployment issues

1. **Two architectures + 3-way ai-gateway port** (§3.5) — an operator can't tell which path is real. PM2+nginx (8085) is the intended one.
2. **Deploying `001` ships the gateway security gaps** (`message:send` IDOR, attachment decode/sanitize bypass) — §6.
3. **`build-frontend.ps1` is unsafe for prod** (secret leak, sibling-repo assumption). Use `deploy/build-frontend.sh` on Linux. (Fixed in PR #31, but the `.ps1` still exists.)
4. **Operator steps remain** (cannot be done without the server/domain): provision host (Docker, Node 20 + pnpm 9, nginx, certbot), DNS A/AAAA for `agent. admin. widget. api. ws. ai.`, fill `.env.prod` secrets, run the `deploy/README.md` sequence (docker infra up → bootstrap → build SPAs → PM2 → nginx + certbot).
5. **Admin job-enqueue still uses a browser build-time token** (`VITE_JOB_PRODUCER_TOKEN`) rather than the user's Directus session (unlike AI/commerce which were fixed). Offered to refactor; not done.
6. **Inbound Yiji webhook is verified/acked but never processed** — order/payment/shipment events are silently dropped (§11).

---

## 8. Workarounds currently in use

- **`docker-compose.override.yml`** (local-only, **not committed**) overrides Postgres → `17-alpine`, publishes `5433:5432`, sets a node-based Directus healthcheck, and sets `NODE_ENV=development` on the (profiled) Node services for local dev.
- **`app` compose profile** so `docker compose up -d` is infra-only and doesn't clash with the PM2 Node tier on `:8080` (PR #33).
- **ai-gateway port via env** — code defaults 8081, real deployment uses 8085 (PM2 sets it).
- **CI treats bootstrap exit code 124 (timeout SIGTERM) as success** because `directus-bootstrap apply` doesn't self-exit — masks a real hang.
- **E2E is non-blocking** (`continue-on-error: true`, `workflow_dispatch` only) so selector drift never reds the board.
- **Redis dev port `127.0.0.1:6380:6379`** (host 6379 is taken by a separate local Redis); `start-prod.ps1` also references a standalone Redis on `:6390` (`crm-app-frontend/.redis-win`).
- **Gemini quota-error regex widened** to catch `"Quota exceeded ..."` phrasing.

---

## 9. Environment setup knowledge

- **OS:** Windows 10 Pro. Shells: PowerShell 7 (`pwsh`, primary) + Git Bash. Node at `C:\Program Files\nodejs`; `pnpm` via corepack; Python 3.14 + pip 26 present; `pwsh` available on the box.
- **Docker:** Docker Desktop, context `desktop-linux`, Server **29.5.3**. It was **stopped** at one point this session — I started it (`"C:\Program Files\Docker\Docker\Docker Desktop.exe"`), and it auto-resumed the stack via `restart: unless-stopped`. Engine pipe: `npipe:////./pipe/dockerDesktopLinuxEngine`.
- **Running locally right now:** Docker infra (`crm-app-infra-postgres-1` [pg17], `-redis-1`, `-directus-1` [healthy], plus `yiji-portals` nginx) + **PM2** running 3 `tsx` Node services (socket-gateway, ai-gateway:8085, workers) from `ecosystem.config.cjs` + `pnpm dev` for the Vite frontends (5173–5175).
- **Docker cleanup performed:** reclaimed ~**18.5 GB** (build cache + obsolete CRM images + orphaned `crm-app_*` volumes + `firecrawl`/`caddy`/`alpine` images). **Kept:** the 4 running images (`nginx:alpine`, `postgres:17-alpine`, `redis:7-alpine`, `directus/directus:11`) and the 3 active `crm-app-infra_*` volumes.
- **Firecrawl:** Docker version fully removed (image + repo `d:\emad\firecrawl` deleted). Now the **global `firecrawl-cli`** (`npm i -g firecrawl-cli`, bin at `C:\Users\e.habibi\AppData\Roaming\npm\firecrawl.ps1`). **Not yet authenticated** — needs `firecrawl login` (free `firecrawl.dev` key) or `FIRECRAWL_API_KEY`.
- **Tooling:** `gh` CLI authenticated for `Anan-alsamaa/crm-app`. Scratchpad temp dir provided by the harness.

---

## 10. Branching and repository knowledge

- **Repo:** `github.com/Anan-alsamaa/crm-app`. **Integration branch:** `001-yiji-crm-platform` (the one to PR into; _not_ `main`).
- **Working directories (separate checkouts of the same repo — beware drift):**
  - `crm-app-quality` → branch `stream/quality` (the **primary** working dir; CLAUDE.md lives here; **stale** vs `001`).
  - `crm-app-infra` → now on **`001-yiji-crm-platform`** (`ef31b01`) after I synced it this session (was on `deploy/linux-build-frontend`). Holds the live Docker/PM2 demo.
  - `crm-app-frontend` → branch `fix/e2e-tickets-first-response` (was `stream/frontend`).
- **`001` tip:** `ef31b01` = "Merge pull request #33". **`app`-profile commit:** `93c1358`.
- **⚠️ `stream/frontend` is NOT an ancestor of `001`** — convergence incomplete (§3.1).
- **PRs merged into `001` this session:** #26 (quality: attachment decode fix + QA tests), #27 (infra: custom-field 500 fix + gateway/AI hardening + deploy arch), #28 (bootstrap idempotence + e2e drift), #29 (frontend: 49 commits widget/admin/tickets/SLA + security), #30 (no-cache SPA shell), #31 (Linux single-repo build + strip widget demo page), #32 (e2e selector fix), #33 (compose `app` profile).
- **PR CLOSED unmerged:** #34 (my redundant `node` profile — superseded by #33).
- **Key local commits:** `86c3549` (infra merge into stream/infra), `734f902`/`d87e9c0` (frontend integration merge + prettier fix).

---

## 11. Features currently unfinished

1. **Inbound Yiji webhook handler** — `socket-gateway/src/index.ts:220-240` verifies HMAC, logs, returns `202`, then drops the event. No consumer for order/payment/shipment. Finish or remove.
2. **Re-landing the lost gateway hardening on `001`** — `message:send` conversation binding + agent-assignment check + `decodeUploadContent`/`sanitizeFilename` on the live upload path.
3. **Job-enqueue session-auth refactor** — move `/jobs/*` off the browser `VITE_JOB_PRODUCER_TOKEN` onto the user's Directus session (parity with AI/commerce). Offered, not started.
4. **4 E2E specs gated behind `E2E_FULL_STACK=1`** (`contact-profile.spec.ts`, `custom-fields.spec.ts`) rarely run.
5. **Firecrawl authentication** — CLI installed but not logged in.

---

## 12. Recommendations for future work (priority order)

1. **Collapse to one repo/branch and re-audit `001` for dropped work.** Make `001` authoritative; convert the per-stream clones to `git worktree`s or archive them. Diff each stream against `001` for **lost hardening/features** (start with `socket-gateway/connection.ts` + `directus.ts`) and re-land. Add a CI guard that fails if a stream branch is ahead of `001` on shared paths. **This is #1 — several "fixes" may just need re-applying.**
2. **Pick one deploy architecture; delete the other.** Keep PM2+nginx; remove/relocate `docker-compose.prod.yml`, Caddy, portal Dockerfiles; standardize the ai-gateway port everywhere; consolidate the four deploy docs into one; capture the decision as an ADR.
3. **Fix the load-bearing bugs:** Gemini model default; `message:send` IDOR; workers retry/backoff/concurrency + email-before-send + UTC business hours + idempotent SLA.
4. **Data tier:** add the missing indexes; replace `limit:-1` with pagination; set sane `QueryClient` defaults.
5. **Make tests a real gate:** add `bootstrap` + `chat-widget` unit tests; add a small **blocking** smoke E2E.
6. **Extract shared code** (`isPlaceholder`, `directusErrorMessage`, `authedFetch`) into packages.
7. **Housekeeping:** delete the dead code in §5; stop committing `tools/*` `node_modules`/logs.

---

## 13. Mistakes that should not be repeated

1. **Trusting "merged + green" without verifying the deployed branch.** I reported the gateway security as preserved after the frontend merge; the risk assessment later proved `001` lacks it. **Always grep/read the actual `001` file after a convergence merge**, especially security-critical handlers — green unit tests did not cover the IDOR.
2. **Blind `git checkout --ours/--theirs` on files needing a 3-way combine.** `--theirs auth.ts` dropped `admin_access`; had to be hand-merged. For conflicts where _both_ sides added distinct value (security + feature), combine deliberately.
3. **Working from a stale local checkout.** My `crm-app-infra` was behind `001`, which caused the Docker "images keep coming back" whack-a-mole and a redundant PR (#34). **`git fetch` + confirm the checkout is at `origin/001` before diagnosing or building a fix.**
4. **Building a fix before checking `001` already has it.** PR #34 duplicated PR #33's `app` profile. Search the integration branch first.
5. **Assuming Docker images "reappearing" meant something was re-running them.** They were orphaned build artifacts from a full `docker compose build` against a compose file that defined Node services PM2 actually runs.

---

## 14. Things another engineer would NOT discover by reading the code

- **`001` is missing security hardening that exists on `stream/quality`/`stream/frontend`** — only visible by diffing branches + checking `git merge-base`. The code on `001` looks complete and tests pass.
- **The "real" deploy architecture is PM2+nginx**, despite `docker-compose.prod.yml`, Caddy configs, and most `docs/*` describing all-Docker+Caddy. The truth is in `deploy/README.md` + a user conversation, not consistently in code.
- **ai-gateway's true port is 8085** (PM2 env), not the 8081 code default.
- **`GEMINI_MODEL` must be set explicitly** — the default is a dead model; you'd only find out at runtime via a 404.
- **`SVC_AI_TOKEN` is intentionally not rotated** (user decision), and **commerce/AI auth was deliberately re-architected** to use the caller's session — not obvious without the C-1/C-2 history.
- **Never run E2E locally against `:8055`** — it pollutes the seeded demo DB the team relies on. (Captured in persistent memory: `no-local-e2e-pollutes-demo-db`.)
- **The local Docker stack on this machine is treated as protected demo data**; `crm-app-infra_*` volumes must survive cleanups.
- **`docker-compose.override.yml` is local-only (uncommitted)** and changes Postgres to 17 + dev mode — `docker compose config` differs from what the committed file alone implies.
- **`build-frontend.ps1` will leak `YIJI_JWT_SECRET`** if used for a real deploy — it's a Windows demo helper only.
- **Firecrawl is intentionally CLI/cloud now**, not Docker (user decision; persistent memory: `firecrawl-via-cli-not-docker`).
- **The upsertContact return-shape change** (object, not string) is why a batch of tests "failed" after a merge — they were stale, not broken by new code.

---

## 15. Context that would be permanently lost if this session disappeared

Everything in §1–§14, but the irreplaceable, non-recoverable-from-code items are:

1. **The integration-integrity landmine** (§3.1, §3.2): `stream/frontend` not an ancestor of `001`, and the gateway security regression on the deployable branch. Without this note, an engineer would deploy `001` believing it carries the security fixes that were announced as "done."
2. **The user's standing decisions:** reuse `SVC_AI_TOKEN` (don't rotate); no local E2E against the demo DB; keep the live demo Docker stack + volumes; Firecrawl via CLI not Docker; the PM2+nginx deploy topology is the chosen one.
3. **What each PR actually resolved and why** (§10) — the merge order and the conflict-resolution rationale (and that #34 was abandoned in favor of #33).
4. **The deploy-architecture rationale** and which of the competing docs/configs is authoritative.
5. **The Docker cleanup end-state + why** (what was deleted vs preserved, and that the recurrence was a stale-checkout artifact, not a live process).
6. **The two companion documents produced this session:** `documentation/project-risk-assessment.md` (full file-line-referenced risk catalog) and this export. Both live under `crm-app-quality/documentation/` (the primary working dir, branch `stream/quality`) — **they are not on `001` and would be lost if that branch is discarded; commit them to `001` to preserve.**

---

### Companion persistent memories (survive in the auto-memory store)

- `no-local-e2e-pollutes-demo-db` — verify E2E in CI, never against the `:8055` demo Directus.
- `firecrawl-via-cli-not-docker` — use the global `firecrawl-cli` + cloud API; don't propose Docker self-host.
- (Recommended to add) the integration-integrity gap + `001` security regression — see the entry created alongside this export.

---

_Generated read-only as a session export. No source code was modified. Branch references are accurate as of `001` = `ef31b01`, 2026-06-24._
