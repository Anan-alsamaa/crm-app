# Yiji CRM — Project Bible (DRAFT)

> **Status:** DRAFT · **Date:** 2026-06-24
> **Synthesized from:** `documentation/repository-audit.md` (infra/repo audit) + `documentation/frontend-audit.md` (frontend audit), cross-checked against live system state (git, Docker, PM2, ecosystem configs, env files).
> **⚠️ Missing input:** `project-risk-assessment.md` was **not found anywhere in the workspace** at the time of writing. The Risk / Ownership sections below are synthesized only from the two available audits + live inspection; **merge the risk assessment in when it lands** (placeholders marked `‹RISK-DOC›`).
> **Scope:** Discovery synthesis only — no code/config/infra was modified producing this document.

---

## 0. Cross-check reconciliation (what disagreed, and the resolved truth)

| Topic                                | repository-audit                             | frontend-audit                                                      | **Resolved truth (verified)**                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI-gateway port**                  | 8085 (from live `.env.local` + PM2)          | code default `8081`, noted hybrid uses 8085                         | **8085** in the running hybrid model. `8081` is the full-Docker compose default and would clash with the gateway's PORT+1 http port — confirmed in `ecosystem.config.cjs` (`AI_GATEWAY_PORT='8085'`). |
| **Job-producer / gateway-http port** | 8081 (admin `.env.local`)                    | `:3031` dev / `:8082` prod                                          | **8081** in the running model — it is the socket-gateway's http port (health/metrics/webhooks + `/jobs/*`). `3031/8082` are other-topology defaults.                                                  |
| **Workers port**                     | none                                         | n/a                                                                 | **No service port**; health on **8083** (hybrid config).                                                                                                                                              |
| **PR #33 (compose `app` profile)**   | merged (`ef31b01`)                           | "open"                                                              | **Merged** — frontend-audit was written minutes before the merge.                                                                                                                                     |
| **Active frontend branch**           | worktree on `fix/e2e-tickets-first-response` | stream is `stream/frontend`                                         | Both true: `stream/frontend` is the integration stream; `fix/e2e-…` is the transient working branch in that worktree.                                                                                 |
| **Auth mode**                        | (not covered)                                | cookie-mode (H-2), httpOnly refresh cookie + in-memory access token | Adopted from frontend-audit; no conflict.                                                                                                                                                             |

No contradictions remained unresolved. The two audits are otherwise consistent on structure, services, and the hybrid deployment model.

---

## 1. System architecture

**Yiji CRM** is a multi-channel customer-support / CRM platform: a customer chat **widget**, an **agent** workspace, and an **admin** console, backed by a **Directus** data layer, a realtime **Socket.IO** gateway, **BullMQ** background workers, and an **AI gateway** that brokers to Gemini (PII-redacted, swappable).

```
                          ┌────────────────────────── Browser / Edge ──────────────────────────┐
   Customer ── widget ───►│  chat-widget (Preact IIFE)   agent-portal (React)   admin-portal     │
                          └───────┬───────────────┬──────────────┬──────────────────┬───────────┘
                                  │ Socket.IO     │ REST (cookie) │ HTTP (Bearer)    │ HTTP (Bearer)
                                  ▼               ▼               ▼                  ▼
                          ┌───────────────┐ ┌───────────┐ ┌───────────────┐  ┌───────────────┐
        PM2 app tier ───► │ socket-gateway│ │ Directus  │ │  ai-gateway   │  │ job producer   │
        (Node / tsx)      │ 8080 + 8081   │ │   8055    │ │     8085      │  │ (= gw :8081)   │
                          └──────┬────────┘ └─────┬─────┘ └──────┬────────┘  └──────┬─────────┘
                                 │ Redis adapter   │ SQL          │ Gemini          │ enqueue
                                 ▼                 ▼              ▼                  ▼
   Docker infra ──►  ┌──────────┐  ┌────────────┐  (external)            ┌──────────────────────┐
   tier             │  Redis 7 │  │ Postgres 17│◄──────────────────────│  workers (BullMQ)     │
                    │  6380    │  │   5433     │   reads/writes via      │  consumes Redis queue │
                    └──────────┘  └────────────┘   Directus + direct     └──────────────────────┘
   Static:  nginx `yiji-portals` serves agent(:8090) + admin(:8092) builds.   ngrok → widget (5175).
```

**Stack (non-negotiable):** pnpm monorepo, TypeScript strict; Directus + Postgres + Redis; Socket.IO (Redis adapter) gateway; BullMQ workers; AI gateway → Gemini (PII redacted, swappable); React 18 + Vite portals + Preact widget; Tailwind, TanStack Query, RHF + Zod, i18next (EN / AR-RTL). Delivered in 6 phases (feature `001-yiji-crm-platform`).

---

## 2. Repositories

| Path                               | Role                                                                                         | Repo / branch                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `crm-app`                          | Product worktree — integration / ops                                                         | `Anan-alsamaa/crm-app` · `main`                                  |
| `crm-app-infra`                    | Product worktree — infra & deploy stream                                                     | same repo · `001-yiji-crm-platform`                              |
| `crm-app-frontend`                 | Product worktree — frontend stream                                                           | same repo · `fix/e2e-tickets-first-response` (`stream/frontend`) |
| `crm-app-quality`                  | Product worktree — quality / e2e stream                                                      | same repo · `stream/quality`                                     |
| `firecrawl`                        | Configured working dir                                                                       | **Missing on disk**                                              |
| `external-repos/*` + `downloads/*` | Third-party skill/tool clones (agent-browser, design-motion-principles, ui-ux-pro-max-skill) | **Duplicated** across two trees; not part of the product         |

- **One product repo, four worktrees** (shared `.git`). All four worktrees are **clean** and in sync with upstream.
- **Source of truth:** `001-yiji-crm-platform` — the **GitHub default branch** and merge target for all stream/fix/deploy PRs. `main` is a secondary ops branch.
- **Monorepo layout** (`pnpm-workspace.yaml`: `apps/*`, `services/*`, `packages/*`, `directus/bootstrap`):
  - `apps/` → `agent-portal`, `admin-portal` (React 18.3 + Vite 6), `chat-widget` (Preact 10 + Vite 6)
  - `services/` → `socket-gateway`, `ai-gateway`, `workers`
  - `packages/` → `ui`, `shared-config`, `shared-types`, `i18n`
  - `directus/` → `bootstrap` (idempotent schema seed), `extensions`, `local`, `snapshot`
  - `deploy/`, `docs/`, `specs/001-yiji-crm-platform/`

---

## 3. Services

### Frontend apps

| App                  | Stack                                  | Purpose                                                                                            | Dev port | Served port                       |
| -------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- | --------------------------------- |
| `@yiji/admin-portal` | React 18.3 + Vite 6                    | Admin console (users, teams, SLA, vendors, automation, reports, custom fields, imports, AI config) | 5174     | **8092** (nginx static)           |
| `@yiji/agent-portal` | React 18.3 + Vite 6 + socket.io-client | Agent workspace (inbox, conversations, tickets, contacts, AI panel)                                | 5173     | **8090** (nginx static)           |
| `@yiji/chat-widget`  | Preact 10 + Vite 6 (lib mode → IIFE)   | Embeddable customer chat (`yiji-chat-widget.js`)                                                   | 5175     | embed / CDN; public via **ngrok** |

### Backend services (Node / `tsx`, run under PM2)

| Service          | Port(s)                                                                             | Purpose                                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket-gateway` | **8080** (Socket.IO) + **8081** (http: health/metrics/webhooks + `/jobs/*` enqueue) | Realtime fan-out (Redis adapter), presence, message/typing/read/note/csat events, attachment upload (MIME/size enforced server-side), job enqueue.                                                                                                              |
| `ai-gateway`     | **8085**                                                                            | Brokers AI endpoints (summarize, suggest-reply, sentiment, intent, entities, semantic-search, lead-score) → Gemini with PII redaction; also the **commerce proxy** (`/commerce/*`, injects the Yiji API key server-side — C-2). Admin config + usage endpoints. |
| `workers`        | health **8083**, no service port                                                    | BullMQ consumer: imports, report generation, email (SMTP).                                                                                                                                                                                                      |

### Data / infra (Docker, official images)

| Service        | Image                           | Port                       | Role                                               |
| -------------- | ------------------------------- | -------------------------- | -------------------------------------------------- |
| `directus`     | `directus/directus:11`          | **8055**                   | Headless data layer + auth + REST API.             |
| `postgres`     | `postgres:17-alpine` (prod: 16) | **5433→5432**              | Primary datastore (`yiji_crm`).                    |
| `redis`        | `redis:7-alpine`                | **6380→6379** (loopback)   | Socket.IO adapter + BullMQ queue + Directus cache. |
| `yiji-portals` | `nginx:alpine`                  | **8090 / 8092** (loopback) | Serves the agent/admin static builds.              |

### Shared packages

- `@yiji/ui` — design system (AppShell, primitives, icons, OKLCH Tailwind preset, Storybook).
- `@yiji/shared-config` — env parsing + Directus auth/service clients (`createAuthClient`, `createServiceClient`).
- `@yiji/shared-types` — Zod schemas + domain types: socket/AI contracts, queues, `YijiClient` commerce boundary.
- `@yiji/i18n` — i18next base config, `en`/`ar` locales, RTL helpers.

---

## 4. Deployment model (HYBRID — the decided model)

**Authoritative runbook:** `deploy/README.md`. Three tiers:

1. **Docker** (official images, data/infra layer): Postgres, Redis, Directus. Compose project `crm-app-infra` (`docker-compose.yml` + `docker-compose.override.yml`; the override pins **postgres:17** to match the v17 dev volume — omitting it risks a v17/v16 crash-loop). The app-tier services are present in compose but **gated behind the `app` profile** (PR #33), so a bare `docker compose up -d` starts **infra only**.
2. **PM2** (Node app services): `socket-gateway`, `ai-gateway`, `workers` via `tsx`. Local = gitignored `ecosystem.hybrid.config.cjs`; prod = committed `ecosystem.config.cjs`. Running the Docker app-tier _and_ PM2 simultaneously is forbidden (8080 clash + duplicate BullMQ consumer).
3. **nginx** (static SPAs): the `yiji-portals` container serves agent/admin builds (`deploy/nginx.local.conf` local; `deploy/nginx/yiji-crm.conf` is the prod TLS edge that also reverse-proxies api/ws/ai). SPA shell served `no-cache`, hashed `/assets/*` immutable (PRs #30/#33).
4. **ngrok** exposes the chat widget (Vite 5175 → reserved `jeane-bootyless-undesigningly.ngrok-free.dev`). Auth token in `~/AppData/Local/ngrok/ngrok.yml`; tunnel in `crm-app-infra/ngrok-tunnels.yml` (start with **both** files).

**Alternative single-host path (not the decided model, kept):** `docker-compose.prod.yml` — full 6-service Docker incl. a profile-gated `bootstrap` container; documented in `docs/PRODUCTION.md`. Fresh-server deploy = install Docker + clone repo → `build` → `up -d postgres redis directus` → `run --rm bootstrap` → `up -d`. No image shipping, no registry.

---

## 5. Workflows

**Development**

- `pnpm install`; bring up backend (hybrid: Docker infra + PM2 services, or full Docker `--profile app`); then `pnpm --filter @yiji/<app> dev` (5173/5174/5175).
- Root scripts: `lint`, `format[:check]`, `typecheck`, `build`, `test`, `test:e2e[:local]`, `test:coverage`, `dev` (all `pnpm -r`).
- Quality gates: ESLint (TS + prettier), Prettier (width 100, single quotes, LF). Husky pre-commit → lint-staged (eslint --fix + prettier; auto-format hook keeps `format:check` green).
- Platform: RAM-tight Windows dev box — prefer single-worker tests + Node heap flag; pnpm lifecycle scripts need PowerShell (node not on PATH in Git-Bash subshells).

**Branch / integration**

- Work happens on per-stream branches (`stream/infra|frontend|quality`) and short-lived `fix/*` / `deploy/*` branches, materialized as **separate worktrees**.
- PRs merge into **`001-yiji-crm-platform`** (the default branch). CI: lint+typecheck+unit, AI/commerce auth contract (C-1/C-2), compose validation, bootstrap idempotence; Playwright E2E is non-blocking.
- Recently landed: security hardening (H-2 cookie auth, C-2 commerce proxy, CSP), bootstrap idempotence, deploy-arch consolidation, Linux frontend build + widget demo-page strip, portal SPA `no-cache`, compose `app` profile gating.

**Deploy** — see §4. Build frontends from the single repo (`deploy/build-frontend.sh`); the widget's dev demo host page (inline JWT mint) is **deleted from the bundle** before publishing.

**Operational model:** code changes are automated (implement + test + branch); operational actions are proposed-only, never auto-applied (one chat-driven rule in CLAUDE.md + `/fix` command).

---

## 6. Dependencies

**Runtime service graph**

- `directus` → `depends_on` `postgres` (healthy) + `redis` (healthy).
- `socket-gateway` → Redis (adapter), Directus (auth/data).
- `ai-gateway` → Gemini (external), Directus (token verify), Yiji commerce API (server-side key).
- `workers` → Redis (BullMQ), Directus (data), SMTP (email).
- `yiji-portals` (nginx) → no compose dependency; serves static, calls backends via baked `VITE_*` URLs (CORS-allowed).
- Frontends → Directus (REST, cookie), socket-gateway (Socket.IO), ai-gateway (HTTP Bearer), gateway `:8081` (`/jobs/*`).

**Frontend state/data dependencies:** TanStack Query 5 (server state), React Context (auth), RHF + Zod (forms), i18next (locale). No global store. `@directus/sdk` 17, `socket.io-client` 4.8.

**Auth dependency chain (cookie-mode, H-2):** login → Directus sets httpOnly refresh cookie, access token in memory → `me()` derives `admin_access` from Directus 11 policies. Requires Directus `CORS_CREDENTIALS=true` + non-Secure SameSite=Lax refresh cookie on local http. Socket auth re-fetches token on every (re)connect; widget uses a static signed customer JWT.

---

## 7. Ownership boundaries

**Stream ownership (worktrees):**

- **infra stream** (`crm-app-infra`) — Docker/compose, deploy kit (`deploy/`), PM2 ecosystem, nginx/ngrok, bootstrap. _Must not touch frontend app source._
- **frontend stream** (`crm-app-frontend`) — `apps/*`, `packages/*`, UI/UX, client integrations.
- **quality stream** (`crm-app-quality`) — E2E/Playwright, test harness, CI quieting.
- **integration/ops** (`crm-app` / `main`) — convergence + operational rules.

**Backend ↔ frontend boundary (from frontend-audit §14 — to be cross-checked against `‹RISK-DOC›`):**

- **Correctly server-mediated:** attachment upload (gateway enforces MIME/size); commerce API key (injected by ai-gateway, C-2); AI/job endpoints re-verify the Directus token server-side; client-side role gating is UX-only (authorization is server-side).
- **Boundary risks flagged:**
  1. **Browser JWT minting (dev/QA only)** in the widget — stripped from prod, but **no build-time guard** prevents baking a real `VITE_WIDGET_JWT_SECRET`. Production must mint the customer token server-side.
  2. **Direct Directus CRUD from the browser** for admin entities (vendors, automation, SLA, custom fields, users) — authorization rests entirely on **Directus collection permissions**; no domain API enforces business rules/tenant ownership/audit beyond Directus. _Functional today; correctness depends on Directus permission config._
  3. **No build-time secret guard** for `VITE_*` (could bake secrets into the client bundle).

**Known technical debt (frontend-audit §11):** ~90% duplication of auth/shell code between admin & agent portals (no shared portal-shell package); `as unknown as` coercions around Directus response shapes; Windows build workarounds (esbuild JSX, separate `vitest.config.ts`); cookie-mode config fragility with no client-side diagnostic.

---

## 8. Environment & secrets (locations only — values not reproduced)

- Per-worktree: `.env`, `.env.example`, `.env.prod`, `.env.prod.example`, `directus/local/.env[.example]`.
- Frontend app builds: `apps/*/.env.local` (gitignored) — `VITE_DIRECTUS_URL` (8055), `VITE_SOCKET_URL` (8080), `VITE_AI_GATEWAY_URL` (**8085**), `VITE_JOB_PRODUCER_URL` (**8081**), plus `VITE_AI_SVC_TOKEN` / `VITE_WIDGET_JWT_SECRET`.
- Backend runtime secrets (in `.env`/`.env.prod`): `YIJI_JWT_SECRET`, `SVC_GATEWAY_TOKEN`/`SVC_WORKERS_TOKEN`/`SVC_AI_TOKEN`, Postgres creds, `GEMINI_*`, `SMTP_*`, `YIJI_WEBHOOK_SECRET`.
- ⚠️ Secrets sit in **plaintext (gitignored) on disk**; `VITE_*` values are **baked at build time** — only non-secret URLs belong there.

---

## 9. Open items for this bible to absorb

1. **Integrate `project-risk-assessment.md`** once it exists — replace every `‹RISK-DOC›` marker; reconcile its risk ratings against §7 boundary risks and §0.
2. **Resolve the missing `firecrawl` workspace** — confirm whether it's deprecated (remove from working dirs) or needs re-cloning.
3. **De-duplicate** the `external-repos/` vs `downloads/` third-party clones.
4. **Confirm prod port story** — bible uses the running hybrid ports (AI 8085, gateway 8081); ensure committed prod env templates and `deploy/README.md` agree, since the full-Docker compose still defaults AI to 8081.

---

_Draft synthesized read-only from two audits + live system inspection on 2026-06-24. No source files were modified. The third input (`project-risk-assessment.md`) was absent and must be merged in before this draft is finalized._
