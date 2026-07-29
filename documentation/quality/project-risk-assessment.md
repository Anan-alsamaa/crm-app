# Yiji CRM — Project-Wide Quality & Risk Assessment

**Date:** 2026-06-24
**Scope:** The converged integration branch **`001-yiji-crm-platform`** (the canonical, deployable source of truth), assessed in the `crm-app-infra` checkout at commit `ef31b01`. This is a pnpm/TypeScript monorepo:

- `services/` — `socket-gateway` (Socket.IO + HTTP app), `ai-gateway` (Gemini, PII-redacted), `workers` (BullMQ)
- `packages/` — `shared-config`, `shared-types`, `ui`, `i18n`
- `apps/` — `agent-portal`, `admin-portal` (React/Vite SPAs), `chat-widget` (Preact embeddable)
- `directus/bootstrap` — schema/roles/seed
- `deploy/`, `docs/`, `tools/`

**Method:** Read-only static review (no code modified). Findings are grounded in `file:line` evidence gathered by four parallel reviewers plus direct spot-verification of the highest-severity items.

**Severity legend:** 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low

---

## Executive summary

The product is feature-complete and, in several areas, notably well-engineered (cookie-mode auth, webhook HMAC verification, no secrets in browser bundles, fail-fast production config, parameter-free DDL). However, the assessment surfaced a small number of **load-bearing risks** that should be addressed before (or immediately after) go-live:

| #   | Risk                                                                                         | Severity | Why it matters                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`GEMINI_MODEL` defaults to retired `gemini-1.5-flash`**                                    | 🟠 High  | Every AI call 404s unless the env explicitly overrides it; the Docker path does not.                                            |
| 2   | **`message:send` is not bound to the socket's conversation**                                 | 🟠 High  | Write-side IDOR: a customer/agent can persist + broadcast a message into _any_ conversation id.                                 |
| 3   | **Two contradictory production architectures ship together**                                 | 🟠 High  | PM2+nginx ("final") vs all-Docker+Caddy; ai-gateway port documented as 8081 / 8085 / 8091. Operators cannot tell which is real. |
| 4   | **Integration integrity gap**                                                                | 🟠 High  | `stream/frontend` is not an ancestor of `001`; gateway hardening present on a stream is absent from the deployable branch.      |
| 5   | **Workers: no retry/backoff/concurrency; email "delivered" before send; UTC business hours** | 🟠 High  | Transient errors fail permanently; delivery records lie; SLA windows wrong for non-UTC tenants.                                 |
| 6   | **Cross-instance presence is broken under `--scale`**                                        | 🟠 High  | Docs recommend `socket-gateway=3`, but presence is per-process → wrong online counts.                                           |
| 7   | **Missing DB indexes + `limit:-1` unbounded scans**                                          | 🟠 High  | Hot paths (SLA sweep, inbox, reports) table-scan and load whole collections into memory.                                        |

The single most important structural observation: **the repository is split across multiple clones/branches (`crm-app-quality`, `crm-app-infra`, `crm-app-frontend`) that have drifted**, and the convergence merges did not all land cleanly (see §11). This is the root cause behind several of the security/feature regressions below and is the top restructuring priority.

---

## 1. Known bugs

| #    | Severity  | Location                                                                                       | Bug                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | --------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | 🟠 High   | `services/ai-gateway/src/config.ts:16`, `provider/gemini.ts:17`, `docker-compose.prod.yml:237` | `GEMINI_MODEL` defaults to **`gemini-1.5-flash`**, a model retired on the public `v1beta generateContent` API → **404 on every AI call** unless explicitly overridden. PM2 (`ecosystem.config.cjs:82`) uses `gemini-2.5-flash`, so Docker and PM2 deployments run different models.                                                                                                          |
| 1.2  | 🟠 High   | `services/socket-gateway/src/connection.ts:268,277,292,309`                                    | **`message:send` IDOR.** The handler persists and broadcasts to the **client-supplied** `conversationId` with no check that it equals the socket's authenticated `data.conversationId` (customer) or that the agent is assigned. The equivalent binding _is_ present on the CSAT handler (`:490`) but not here. A customer/agent can inject persisted messages into arbitrary conversations. |
| 1.3  | 🟠 High   | `services/workers/src/processors/notifications.ts:43-66`                                       | Email **"delivered" timestamp is written before the email is sent** (`channelEmailDeliveredAt: email ? now : undefined` is persisted first; the send is attempted afterward and failures only logged). Rows claim delivery for mail that never went out.                                                                                                                                     |
| 1.4  | 🟡 Medium | `services/workers/src/lib/sla-clock.ts:26-41`                                                  | **Business hours computed in UTC**, ignoring `BusinessHours.timezone` (e.g. `Asia/Riyadh`, the EN/AR target market). Weekday/open-close boundaries shift by the offset → wrong SLA windows and off-by-one at week edges.                                                                                                                                                                     |
| 1.5  | 🟡 Medium | `services/workers/src/processors/sla.ts:62,69,148-168`                                         | **SLA warning/breach re-fires every 60 s.** With `removeOnComplete:true`, a completed warning job is removed, so the next reconcile re-adds the same `jobId` and it fires again; no dedup on `createTicketEvent`/`enqueueNotification`.                                                                                                                                                      |
| 1.6  | 🟡 Medium | `services/socket-gateway/src/connection.ts:~338`                                               | **Live attachment upload bypasses the corruption-safe helpers.** It uses `Buffer.from((data.content).buffer)` (ignores `byteOffset`/`byteLength` — the exact bug `attachments.ts:decodeUploadContent` was written to prevent) and never calls `sanitizeFilename`. Possible byte corruption on pooled buffers + unsanitized filenames.                                                        |
| 1.7  | 🟡 Medium | `services/ai-gateway/src/ratelimit/index.ts:96-102`                                            | **Monthly-cap `INCR`-then-`DECR` is non-atomic.** Concurrent reads see an inflated counter; a crash between the two permanently over-charges the month. TTL is set only when `used===1` (`:92`), so a failed `EXPIRE` leaves an immortal key.                                                                                                                                                |
| 1.8  | 🟡 Medium | `apps/agent-portal/src/features/conversation/ConversationView.tsx:352-368`                     | **Optimistic agent reply never rolls back.** A reply renders `pending:true` and is reconciled only on the gateway `message:new` echo; there is no error/timeout handler, so a dropped/rejected emit leaves the message stuck "pending" forever while the agent believes it sent.                                                                                                             |
| 1.9  | 🟡 Medium | `services/socket-gateway/src/index.ts:247,257`                                                 | **`/jobs/*` admin gate matches role by display-name string** (`['Admin','Administrator']`, case-sensitive). Renaming the Directus admin role locks out admins; a custom non-privileged role literally named "Admin" passes. (Otherwise token-validated server-side and not bypassable.)                                                                                                      |
| 1.10 | 🟡 Medium | `services/workers/src/processors/automation.ts:289-291`                                        | **Inactivity sweep capped at `limit:200` with no pagination** — beyond 200 stale conversations per 5-min cycle, the remainder are never swept.                                                                                                                                                                                                                                               |
| 1.11 | ⚪ Low    | `services/ai-gateway/src/provider/gemini.ts:64`                                                | Status-parse regex only matches **bracketed** codes (`/\[(\d{3})\b/`); an unbracketed `... 404 Not Found` returns null, so 1.1's failures are neither classified nor retried.                                                                                                                                                                                                                |
| 1.12 | ⚪ Low    | `services/workers/src/processors/sla.ts:130-131`                                               | `new Date(... ?? ...!)` can yield `Invalid Date` → `NaN` delays if the field is an empty string (currently guarded but fragile).                                                                                                                                                                                                                                                             |

---

## 2. Duplicate code

| #   | Location                                                                                                                                                                                    | Duplication                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | `services/{ai-gateway,socket-gateway,workers}/src/config.ts:5`                                                                                                                              | **`isPlaceholder` env helper copy-pasted verbatim** in all three services. Belongs in `@yiji/shared-config` next to the already-shared `parseEnv`/`numericEnv`.                                                                 |
| 2.2 | `directus/bootstrap/src/apply.ts:48` (`errorMessage`), `services/socket-gateway/src/connection.ts:63` (`extractAuthError`), `services/workers/src/processors/notifications.ts:69`           | **Directus-SDK error-message extraction** reimplemented three times under different names — should be one shared `directusErrorMessage()`.                                                                                      |
| 2.3 | `apps/agent-portal/src/lib/ai-client.ts:38`, `apps/admin-portal/src/lib/ai-client.ts:31`, `apps/agent-portal/src/lib/commerce-client.ts:20`, `apps/admin-portal/src/lib/job-producer.ts:37` | **Browser bearer-token fetch wrapper re-implemented 4×** (read `VITE_*_URL` → `auth.getToken()` → `Authorization: Bearer` → throw `Object.assign(Error, {status,payload})`). Should be one shared `authedFetch`/gateway client. |
| 2.4 | `apps/{admin,agent}-portal/src/lib/directus.ts`                                                                                                                                             | Portal Directus singleton bootstrap duplicated (minor — heavy lifting already shared via `createAuthClient`).                                                                                                                   |

_Confirmed **not** duplicated (good):_ entity Zod schemas (centralized in `packages/shared-types`), the service Directus client (`createServiceClient`), JWT/token helpers, `sleep`/`cn`/`redact`.

---

## 3. Dead code

| #   | Location                                                                                                                        | Finding                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | `docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/docker-compose.proxy.yml`, `apps/{agent,admin}-portal/Dockerfile`        | **An entire superseded deploy model.** `deploy/README.md` declares the "final" architecture as Docker-infra + **PM2** + **nginx**, but the older **all-Docker + Caddy** model still ships and is wired into CI (`.github/workflows/deploy-preflight.yml:43`, `deploy.yml:112`) and four docs. The portal Dockerfiles + Caddyfile + proxy compose are dead under the chosen model. (See §10 and §12.) |
| 3.2 | `tools/{bull-board,job-producer,load-test,screenshot}`                                                                          | Orphaned local utilities — **zero references** in any `package.json`/CI/script, and they contain committed runtime artifacts (`tools/bull-board/bb.{err,out}`, `tools/job-producer/jp.{err,out}`) and committed `node_modules`.                                                                                                                                                                      |
| 3.3 | `scripts/shot-revamp.mjs`, `scripts/shot-widget-mobile.mjs`, `scripts/shot-widget-offline.mjs`, `scripts/inspect-login-btn.mjs` | Unreferenced one-off screenshot/inspection helpers.                                                                                                                                                                                                                                                                                                                                                  |
| 3.4 | `packages/shared-config/src/env.ts:41` (`redisUrlSchema`)                                                                       | Exported (and re-exported at `index.ts:9`) but **never imported anywhere** — unused public API.                                                                                                                                                                                                                                                                                                      |
| 3.5 | `services/workers/src/processors/index.ts:28-31,49-53`                                                                          | `notImplemented` factory is unused and explicitly `void`-ed ("no longer used … Remove on next refactor"); the registry doc comment still claims processors are "no-op stubs."                                                                                                                                                                                                                        |
| 3.6 | `.gitignore.resolved`                                                                                                           | 0-byte git-tracked file with no purpose.                                                                                                                                                                                                                                                                                                                                                             |
| 3.7 | `services/workers/src/processors/reports.ts:371`                                                                                | Unreachable "not yet implemented" report fallback (all 7 `ReportType` values have aggregators).                                                                                                                                                                                                                                                                                                      |

---

## 4. Incomplete features

| #   | Severity           | Location                                                                                                                                     | Finding                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | 🟠 High            | `services/socket-gateway/src/index.ts:220-240`                                                                                               | **Inbound Yiji webhook is verified, logged, `202`-acked, then discarded.** The comment claims "downstream processing is wired by the consuming pipeline," but `SideEffectProducer` only exposes `enqueueImport`/`enqueueReport` — order/payment/shipment events are silently dropped. Either finish the consumer or remove the endpoint. |
| 4.2 | 🟡 Medium          | `apps/agent-portal/tests/e2e/contact-profile.spec.ts:35,58,88`, `custom-fields.spec.ts:24`                                                   | E2E specs gated behind `E2E_FULL_STACK=1`; in practice they rarely run (the full-stack job is non-blocking).                                                                                                                                                                                                                             |
| 4.3 | ⚪ Low (by design) | `packages/shared-types/src/yiji-impl.ts:290`, `ai-gateway/src/index.ts:51`, `workers/src/mail/index.ts:40`, `socket-gateway/src/queue.ts:30` | Intentional env-gated stubs (mock commerce, AI 503 when no key, no-op SMTP, no-op queue) — documented and blocked in prod by config. Listed for completeness; not defects.                                                                                                                                                               |

---

## 5. Missing tests

| #   | Severity  | Area                  | Gap                                                                                                                                                                                                                                              |
| --- | --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.1 | 🟠 High   | `directus/bootstrap/` | **No `tests/` directory at all.** Role/constraint/collection construction is unit-untested; only an integration idempotence check (`scripts/check-idempotence.mjs`) runs in CI, and only on path-triggered PRs.                                  |
| 5.2 | 🟠 High   | `apps/chat-widget/`   | **No unit tests** for the embeddable widget (`Widget.tsx`, `socket.ts`, `embed.ts`, reconnection/JWT logic). `vitest.config.ts` sets `passWithNoTests:true` with no coverage thresholds.                                                         |
| 5.3 | 🟡 Medium | `packages/ui/`        | 40+ components covered only by Storybook stories (not run in CI) and indirectly via app tests; explicitly excluded from coverage gating.                                                                                                         |
| 5.4 | 🟠 High   | CI gating             | **The Playwright E2E job never gates CI** — `.github/workflows/ci.yml:87` runs it only on `workflow_dispatch` **and** `continue-on-error:true` (`:92`), so even a manual run can't turn CI red. The whole UI integration suite is advisory only. |
| 5.5 | 🟡 Medium | CI bootstrap step     | `ci.yml:245-255` treats exit code 124 (timeout SIGTERM) as success because the apply step "does not self-exit" — a real hang is indistinguishable from a slow success.                                                                           |

_Well covered (good):_ ai-gateway provider error mapping / redaction / rate-limits; socket reconnection; all worker processors; services enforce ≥70% line coverage; a genuinely blocking `auth-contract` integration job exists.

---

## 6. Security concerns

> See also §1.2 (`message:send` IDOR) and §1.6 (attachment decode/sanitize) — both also security-relevant.

| #   | Severity  | Location                                                    | Finding                                                                                                                                                                                                                                                                                             |
| --- | --------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | 🟠 High   | `services/socket-gateway/src/connection.ts:268`             | **Write-side IDOR on `message:send`** (full detail in §1.2). The conversation-binding guard that exists on the frontend stream is **absent from the converged `001`** — see §11 integration gap.                                                                                                    |
| 6.2 | 🟠 High   | `services/socket-gateway/src/auth/customer-jwt.ts:18-30,45` | **Customer JWT has no mandatory expiry.** `exp` is optional and `jwt.verify` is called with no `maxAge`, so a host-minted token without `exp` **never expires** — a leaked customer token is valid forever. (The widget already assumes expiry exists.)                                             |
| 6.3 | 🟠 High   | `directus/bootstrap/src/roles.ts:120,127`                   | **Agent `contacts.read` and `messages.read` are unfiltered (all-vendor).** Conversations are scoped, but any authenticated agent can read every vendor's contacts and message bodies via the Directus API. Accepted for a single-tenant shared inbox; a real cross-tenant exposure if multi-tenant. |
| 6.4 | 🟡 Medium | `services/ai-gateway/src/redaction/index.ts:46-64`          | **PII redaction over- and under-matches.** The phone regex matches almost any 7–15 digit run (over-redacts, degrades prompts); national-ID only matches US `\d{3}-\d{2}-\d{4}`, so **Saudi/Iqama 10-digit IDs are not redacted** before reaching Gemini.                                            |
| 6.5 | 🟡 Medium | `services/socket-gateway/src/connection.ts:334-341`         | Upload **MIME is trusted from the client** (claimed type checked against allow-list, bytes never sniffed) → a customer can upload HTML/executable labeled `text/plain`. Retrieval is correctly conversation-scoped, so this is content-type spoofing, not IDOR.                                     |
| 6.6 | 🟡 Medium | `docker-compose.yml:53-56,74`                               | Dev compose ships weak defaults (`ADMIN_PASSWORD: admin`, `dev-…-change-me`, `CORS_ORIGIN:'true'`). Mitigated by the prod compose's `${VAR:?}` hard-fail + zod `superRefine`, but the defaults exist if the dev file is mistakenly used.                                                            |
| 6.7 | ⚪ Low    | `services/socket-gateway/src/index.ts:291`                  | `/debug/presence` has no auth (leaks agent ids/socket counts). Bound loopback-only and the edge proxy is documented to keep `/debug` internal — relies on proxy discipline.                                                                                                                         |

**Notably well done (balance):** no secrets in browser bundles (AI/commerce/jobs all use the user's server-verified Directus session; the widget only _receives_ a platform-signed token); cookie-mode auth (refresh token httpOnly/Secure, access token in memory only); textbook webhook HMAC verification (timing-safe, replay window, 503 when unset); parameter-free DDL (no SQL injection surface); Redis-backed Directus rate limiter + per-socket token buckets; append-only `ticket_events` and withheld `messages.update`.

---

## 7. Performance concerns

| #    | Severity  | Location                                                                                            | Finding                                                                                                                                                                                                                                              |
| ---- | --------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | 🟠 High   | `services/socket-gateway/src/connection.ts:90,93`                                                   | **Presence is per-process but broadcast globally.** Under the docs-recommended `--scale socket-gateway=3`, each instance counts only its own agents → wrong online counts; defeats the Redis-adapter multi-instance claim.                           |
| 7.2  | 🟠 High   | `services/socket-gateway/src/connection.ts:93`                                                      | `io.emit(...)` fans **every** agent login/logout out to **all** sockets (all widgets + agents) — an N-socket broadcast per login event.                                                                                                              |
| 7.3  | 🟠 High   | `services/workers/src/index.ts:108-118`                                                             | **Every BullMQ Worker omits `concurrency`, `attempts`, and `backoff`** → BullMQ defaults to no retry + concurrency 1; transient Directus errors fail permanently and any retry would be a thundering herd.                                           |
| 7.4  | 🟠 High   | `services/workers/src/processors/reports.ts` (8 sites), `directus-repos.ts:33`, `automation.ts:219` | **`limit:-1` full-collection scans.** Reports with empty filters load entire `tickets`/`conversations`/`csat_responses` into Node memory; `listOpenTickets` runs every 60 s.                                                                         |
| 7.5  | 🟠 High   | `directus/bootstrap/src/constraints.ts`, `apply.ts:218-227`                                         | **Missing indexes on hot filter/sort columns** (FKs created `is_indexed:false`): `tickets.status`, `tickets.assigned_agent`, `conversations.{vendor,status,assigned_agent}` — every SLA sweep, "assigned to me", inbox, and report filters on these. |
| 7.6  | 🟠 High   | `services/ai-gateway/src/provider/gemini.ts:41`                                                     | **No timeout/`AbortSignal` on the Gemini call** (Directus calls correctly use `AbortSignal.timeout(5_000)`). A hung upstream blocks the paid request path indefinitely, ×3 attempts.                                                                 |
| 7.7  | 🟡 Medium | `apps/*/src/main.tsx:8`, multiple `features/*/api.ts`                                               | Portals use `new QueryClient()` with no defaults (`staleTime:0`, `refetchOnWindowFocus:true`) **and** `limit:-1` on hot lists → every window focus re-pulls entire conversation/contact/ticket lists.                                                |
| 7.8  | 🟡 Medium | `services/workers/src/processors/sla.ts:103-136`                                                    | SLA reconcile is an **N+1 write loop** (2 patches + 2 queue adds per open ticket, every 60 s).                                                                                                                                                       |
| 7.9  | 🟡 Medium | `apps/{agent,admin}-portal/vite.config.ts`                                                          | No `manualChunks`/`chunkSizeWarningLimit`; all vendor libs land in one >500 KB chunk (routes _are_ lazy-split, which helps).                                                                                                                         |
| 7.10 | 🟡 Medium | `services/ai-gateway/src/ratelimit/index.ts:27`, `cache/index.ts:24`                                | Rate-limit Lua uses `math.random` for ZSET members (collision/replication risk); cache key omits model/prompt version → stale old-model responses served after a model swap.                                                                         |

---

## 8. Dependency issues

| #   | Severity  | Location                                                                                           | Finding                                                                                                                                                                                         |
| --- | --------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | 🟠 High   | `ecosystem.config.cjs:82` vs `ai-gateway/src/config.ts:16`, `docker-compose*.yml`, `.env*.example` | **`GEMINI_MODEL` default split** — `gemini-2.5-flash` (PM2) vs `gemini-1.5-flash` (code + Docker). Root cause of bug §1.1.                                                                      |
| 8.2 | 🟡 Medium | `services/ai-gateway/package.json`                                                                 | Uses legacy `@google/generative-ai@^0.21.0` (superseded by `@google/genai`); pairing it with a 2.5 model risks an unsupported-model error on the old client.                                    |
| 8.3 | 🟡 Medium | `packages/ui/package.json:27` vs `apps/{agent,admin}-portal/package.json`                          | `@types/react-dom` drift (`^18.3.7` vs `^18.3.5`).                                                                                                                                              |
| 8.4 | 🟡 Medium | all three services                                                                                 | Heavy OpenTelemetry stack shipped as **runtime** deps (`auto-instrumentations-node@^0.76.0`, `sdk-node@^0.218.0`, …) — large transitive tree; `0.x` pins move fast.                             |
| 8.5 | ⚪ Low    | `services/workers/package.json`                                                                    | `ioredis-mock` present in ai-gateway + socket-gateway but absent from workers — inconsistent test tooling.                                                                                      |
| 8.6 | ⚪ Low    | repo-wide                                                                                          | All deps use caret (`^`) ranges; reproducibility relies entirely on the committed `pnpm-lock.yaml` (CI uses `--frozen-lockfile`, which is good). No `latest`/`*` pins found; lockfile is fresh. |

---

## 9. Build issues

| #   | Severity  | Location                                                  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 | 🟠 High   | `build-frontend.ps1` vs `deploy/build-frontend.sh`        | **Two divergent frontend builds with opposite security postures.** The PowerShell script builds from a _sibling_ `crm-app-frontend` repo and **injects the real `YIJI_JWT_SECRET`** into the widget host page; the bash script builds from the self-contained checkout and **deletes** the demo host page. Easy to ship the insecure artifact. (The `.sh`/README were corrected; the `.ps1` remains and is still referenced as a fallback.) |
| 9.2 | 🟡 Medium | `apps/chat-widget/vite.config.ts:33-105`                  | The widget lib build emits a demo `index.html` containing an in-browser HS256 mint. Safe **only** because `build-frontend.sh` strips it; serving the raw `dist/` exposes a token-minting page.                                                                                                                                                                                                                                              |
| 9.3 | 🟡 Medium | `apps/{agent,admin}-portal/package.json`, `tsconfig.json` | `tsc -b && vite build` with `"noEmit":true` and no project `references`/`tsconfig.node.json` — a non-standard `tsc -b` combo that can no-op or warn depending on tsc version.                                                                                                                                                                                                                                                               |
| 9.4 | 🟡 Medium | `apps/{agent,admin}-portal/vite.config.ts`                | No `manualChunks`/chunk-size config (see §7.9).                                                                                                                                                                                                                                                                                                                                                                                             |
| 9.5 | ⚪ Low    | `services/*/src/config.ts` (`superRefine`)                | Production `NODE_ENV` guards intentionally **hard-fail** boot on `CORS_ORIGIN:'*'`, `REDIS_ENABLED:false`, weak JWT secret, or placeholder tokens. Correct, but one stray env makes a service refuse to start — document loudly.                                                                                                                                                                                                            |

_Note:_ services have **no `build` script** (run via `tsx`) and **no `test` script** — their tests are picked up only by the root vitest glob, so `pnpm -r test` (used at `ci.yml:54`) silently skips them; coverage runs via `pnpm test:coverage`.

---

## 10. Documentation gaps

| #    | Severity  | Location                                                             | Finding                                                                                                                                                                                                                                                                                                                |
| ---- | --------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.1 | 🟠 High   | `deploy/README.md` vs `docs/DEPLOYMENT.md`, `docs/PRODUCTION.md`     | **Two mutually exclusive "the" production paths.** `deploy/README.md` = Docker-infra + PM2 + nginx ("final"); `docs/DEPLOYMENT.md`/`PRODUCTION.md` = all-Docker `docker-compose.prod.yml` + Caddy ("recommended default"). Different process managers, proxies, topologies. None of the older docs are marked retired. |
| 10.2 | 🟠 High   | `config.ts:10` / `ecosystem.config.cjs:36` / `docs/LOCAL_PROD.md:17` | **ai-gateway port documented three ways: 8081 (code/Docker) / 8085 (PM2) / 8091 (LOCAL_PROD).** Health-check/verify commands in `docs/PRODUCTION.md` scrape 8081 while PM2 listens on 8085.                                                                                                                            |
| 10.3 | 🟡 Medium | `deploy/README.md:30-32`, `docs/LOCAL_PROD.md:42`                    | Stale references to a **sibling `crm-app-frontend` repo** for the SPAs and a root `.env`, although `001` is now self-contained (apps live in this repo).                                                                                                                                                               |
| 10.4 | 🟡 Medium | repo-wide                                                            | Missing: `AGENTS.md`, per-service/per-app READMEs, ADRs (the Docker-vs-PM2 / Caddy-vs-nginx decisions are exactly what an ADR should pin), a standalone env-var reference, and a discoverable incident runbook file (only a buried table in `PRODUCTION.md`).                                                          |
| 10.5 | ⚪ Low    | `deploy/README.md:82`, `docs/LOCAL_PROD.md`                          | Gemini model + `VITE_AI_SVC_TOKEN` removal documented inconsistently across files.                                                                                                                                                                                                                                     |

---

## 11. High-risk areas of the system

1. **Repository / branch integrity (🟠 highest structural risk).** The project lives in **three drifted clones** (`crm-app-quality`, `crm-app-infra`, `crm-app-frontend`) on different branches. `git merge-base --is-ancestor origin/stream/frontend origin/001` returns **false**, and security hardening verified to exist on a stream (the `message:send` conversation guard, `decodeUploadContent`, `sanitizeFilename`) is **absent from the deployable `001`**. Convergence merges have silently dropped work. Any assessment, fix, or deploy is only as trustworthy as "which checkout am I in." This single issue underlies §1.2, §1.6, §6.1.

2. **`socket-gateway` real-time core.** Presence correctness breaks under horizontal scale (§7.1–7.2), the message path has a write IDOR (§1.2), and attachment handling diverged from its safe helpers (§1.6). This is the most-exercised, highest-blast-radius service and concentrates several findings.

3. **`workers` (BullMQ) reliability.** No retry/backoff/concurrency (§7.3), non-idempotent SLA re-fire (§1.5), delivery-before-send (§1.3), UTC business hours (§1.4), unbounded scans every tick (§7.4). Background jobs are where silent data drift accumulates.

4. **AI gateway availability.** Default model 404 (§1.1), no upstream timeout (§7.6), error mis-classification (§1.11). A core advertised feature is one mis-set env away from total failure.

5. **Deploy/ops ambiguity.** Two architectures + three ports (§10.1–10.2). The risk is a misconfigured production install that _looks_ documented.

6. **Data-tier scalability.** Missing indexes + `limit:-1` everywhere (§7.4–7.5, §7.7) means the system performs fine on seed data and degrades sharply with real volume.

---

## 12. Recommendations for project restructuring

**A. Collapse to a single repository and branch model (do this first).**

- Designate **`001-yiji-crm-platform`** the single source of truth and **archive the per-stream clones** (`crm-app-quality`, `crm-app-infra`, `crm-app-frontend`) or convert them to `git worktree`s of one repo so they cannot drift.
- Re-audit `001` against each stream for **dropped hardening/features** (start with `socket-gateway/src/connection.ts` and `directus.ts`) and re-land anything lost. Add a CI check that fails if a stream branch is ahead of `001` on shared paths.

**B. Pick one deployment architecture and delete the other.**

- Keep the documented "final" (Docker-infra + PM2 + nginx). **Remove** `docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/docker-compose.proxy.yml`, and `apps/*/Dockerfile`, or move them to an `examples/` folder clearly labeled "alternative." Update CI (`deploy-preflight.yml`, `deploy.yml`) and retire `docs/{DEPLOYMENT,PRODUCTION,LOCAL_PROD,GO-LIVE-READINESS}.md` into one canonical runbook. Standardize the ai-gateway port (one value) everywhere. Capture the decision in an **ADR**.

**C. Extract shared cross-cutting code into `packages/`.**

- `isPlaceholder`, `directusErrorMessage`, and a browser `authedFetch`/gateway client (§2) into `@yiji/shared-config` / a new `@yiji/client`. Removes 3–4 copies and the matching drift risk.

**D. Harden the two reliability-critical services.**

- `workers`: set `concurrency`, `attempts`, and exponential `backoff` on every Worker; make SLA jobs idempotent; fix delivery-before-send; make business hours timezone-aware; paginate sweeps.
- `socket-gateway`: bind `message:send`/attachment events to the authenticated conversation; move presence to a shared Redis store; replace global `io.emit` with room-scoped emits.

**E. Make tests a real gate.**

- Add `directus/bootstrap` and `chat-widget` unit tests (§5.1–5.2); add a **blocking** smoke E2E (a handful of critical-path specs that gate CI) while keeping the full suite advisory; enforce coverage on `chat-widget`.

**F. Data tier.**

- Add indexes on `tickets.status`, `*.assigned_agent`, `conversations.{vendor,status}`; replace `limit:-1` with pagination/bounded windows in workers and portals; set sane `QueryClient` defaults (`staleTime`, disable refetch-on-focus for large lists).

**G. Housekeeping.**

- Delete dead code (§3): orphaned `tools/*` (and stop committing `node_modules`/`*.out` logs), unused scripts, `.gitignore.resolved`, `redisUrlSchema`, the `notImplemented` factory.
- Resolve the `GEMINI_MODEL` default to a current model in every location; add a `.env` reference doc; add a `.gitignore` rule for build/run logs.

---

### Appendix — what's already strong (so restructuring doesn't regress it)

Cookie-mode auth with no browser-stored secrets; server-verified AI/commerce/jobs via the user's Directus session; HMAC webhook verification; parameter-free idempotent DDL; fail-fast production config (`${VAR:?}` + zod `superRefine`); Redis-backed rate limiting at multiple layers; append-only audit (`ticket_events`); solid CSP/HSTS on the nginx edge; ≥70% enforced coverage on the services; a blocking `auth-contract` CI gate. Preserve these guarantees through any refactor.

---

_Prepared read-only; no source files were modified. Line references are to the `001-yiji-crm-platform` branch as checked out in `crm-app-infra` at `ef31b01`._
