# Workspace & Repository Audit

> **Scope:** Read-only discovery of the entire workspace and all accessible repositories.
> **Generated:** 2026-06-24 · Host: Windows 10 (this dev box) · No code/config/infra/docs were modified (this report file is the only artifact created).
> **Secrets:** Tokens / JWT secrets found in env files are referenced by _location and key name only_; their values are deliberately **not reproduced** here.

---

## 0. Executive summary

- There is **one product repository** — `Anan-alsamaa/crm-app` (the **Yiji CRM platform**) — checked out as **four git worktrees** of the same repo, each parked on a different branch.
- The configured working directory `d:/emad/firecrawl` **does not exist** on disk.
- Six additional git repos under `d:/emad` are **third-party skill/tool clones**, each **duplicated** across `external-repos/` and `downloads/`. None are part of the CRM product.
- Live runtime is the **HYBRID** model: Docker runs the data/infra tier (Postgres, Redis, Directus); **PM2** runs the three Node app services; a standalone **nginx** container serves the portal builds; **ngrok** exposes the chat widget.

---

## 1. All repositories found

| #   | Path                                                      | Type                          | Git repo?                  |
| --- | --------------------------------------------------------- | ----------------------------- | -------------------------- |
| 1   | `d:/emad/Afcoapp/ProgramFile/claudeCode/crm-app`          | Product worktree (`crm-app`)  | ✅                         |
| 2   | `d:/emad/Afcoapp/ProgramFile/claudeCode/crm-app-infra`    | Product worktree (`crm-app`)  | ✅                         |
| 3   | `d:/emad/Afcoapp/ProgramFile/claudeCode/crm-app-frontend` | Product worktree (`crm-app`)  | ✅                         |
| 4   | `d:/emad/Afcoapp/ProgramFile/claudeCode/crm-app-quality`  | Product worktree (`crm-app`)  | ✅                         |
| 5   | `d:/emad/firecrawl`                                       | Configured working dir        | ❌ **Path does not exist** |
| 6   | `d:/emad/external-repos/agent-browser`                    | Third-party clone             | ✅                         |
| 7   | `d:/emad/external-repos/design-motion-principles`         | Third-party clone             | ✅                         |
| 8   | `d:/emad/external-repos/ui-ux-pro-max-skill`              | Third-party clone             | ✅                         |
| 9   | `d:/emad/downloads/agent-browser`                         | Third-party clone (dup of #6) | ✅                         |
| 10  | `d:/emad/downloads/design-motion-principles`              | Third-party clone (dup of #7) | ✅                         |
| 11  | `d:/emad/downloads/ui-ux-pro-max-skill`                   | Third-party clone (dup of #8) | ✅                         |

> Worktrees #1–#4 share **one** `.git` (the `crm-app` repository) — they are not independent copies. Confirmed via `git worktree list`.

---

## 2. Repository purpose

- **`crm-app` (worktrees #1–#4)** — The **Yiji CRM platform** (feature `001-yiji-crm-platform`). A pnpm monorepo (TypeScript strict):
  - `apps/` — `agent-portal`, `admin-portal` (React 18 + Vite), `chat-widget` (Preact embeddable).
  - `services/` — `socket-gateway` (Socket.IO + Redis adapter), `ai-gateway` (→ Gemini, PII-redacted), `workers` (BullMQ).
  - `packages/` — `shared-types`, `shared-config`, `i18n`, `ui`.
  - `directus/` — Directus 11 headless CMS/data layer: `bootstrap` (schema seed), `extensions`, `local` (extension dev), `snapshot`.
  - `deploy/`, `docs/`, `specs/` — production runbook, docs, and the 001 design artifacts.
- **`firecrawl`** — Intended web-scraping tool/workspace; **not present on disk**, so purpose unverifiable here.
- **`agent-browser`** (vercel-labs) — Third-party agentic browser tool.
- **`design-motion-principles`** (kylezantos) — Third-party design/motion reference.
- **`ui-ux-pro-max-skill`** (nextlevelbuilder) — Third-party UI/UX skill pack.

---

## 3. Git remotes

| Repo                                                       | `origin` remote                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `crm-app` (all 4 worktrees)                                | `https://github.com/Anan-alsamaa/crm-app.git`                 |
| `external-repos/agent-browser` & `downloads/agent-browser` | `https://github.com/vercel-labs/agent-browser.git`            |
| `external-repos/design-motion-principles` & `downloads/…`  | `https://github.com/kylezantos/design-motion-principles.git`  |
| `external-repos/ui-ux-pro-max-skill` & `downloads/…`       | `https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git` |
| `firecrawl`                                                | n/a (path missing)                                            |

---

## 4. Default branches

- **`crm-app` GitHub default branch: `001-yiji-crm-platform`** (visibility: **PUBLIC**). _Note:_ the local worktrees do **not** have `origin/HEAD` set (`symbolic-ref` returns none), but the GitHub repo default is `001-yiji-crm-platform`.
- `main` exists but is **not** the GitHub default — it carries ops/meta history (last commit: _"refactor(ops): simplify to one chat-driven rule"_).
- Third-party repos: default branches not individually queried (out of product scope); each tracks its upstream `origin`.

---

## 5. Current branches (per worktree)

| Worktree           | Current branch                   | HEAD      | Notes                                                               |
| ------------------ | -------------------------------- | --------- | ------------------------------------------------------------------- |
| `crm-app`          | `main`                           | `d1f210d` | ops/meta branch                                                     |
| `crm-app-infra`    | `001-yiji-crm-platform`          | `ef31b01` | merge of PR #33 (switched here mid-session by a concurrent session) |
| `crm-app-frontend` | `fix/e2e-tickets-first-response` | `80a58cf` | e2e selector fix                                                    |
| `crm-app-quality`  | `stream/quality`                 | `9559a87` | portal SPA no-cache (edge nginx)                                    |

> **Concurrency note:** during this audit, a **parallel session** was actively switching branches and merging PRs in these worktrees (e.g. the infra worktree moved from `deploy/linux-build-frontend` → `001-yiji-crm-platform`). Branch state is therefore a moving target.

Other notable branches seen in the repo: `stream/frontend`, `stream/infra`, `stream/quality` (the three integration streams), plus short-lived `fix/*` and `deploy/*` branches.

---

## 6. Uncommitted changes

| Worktree           | Status                      |
| ------------------ | --------------------------- |
| `crm-app`          | **Clean** (0/0 vs upstream) |
| `crm-app-infra`    | **Clean** (0/0 vs upstream) |
| `crm-app-frontend` | **Clean** (0/0 vs upstream) |
| `crm-app-quality`  | **Clean** (0/0 vs upstream) |

All four worktrees are clean and in sync with their upstream. _(This report adds one new untracked file, `documentation/repository-audit.md`, in the worktree it is written to.)_

---

## 7. Relationship between repositories

- **`crm-app`** is a single repo materialized as **4 worktrees**, one per "stream"/role:
  - `crm-app` → integration / ops (`main`)
  - `crm-app-infra` → infra & deploy stream
  - `crm-app-frontend` → frontend stream
  - `crm-app-quality` → quality/e2e stream
  - They share history and the same `origin`; work converges via PRs into **`001-yiji-crm-platform`**.
- **External skill repos** are unrelated to the product — vendored references/tools, kept in two parallel trees (`external-repos/` and `downloads/`).
- **`firecrawl`** has no established relationship (missing).

---

## 8. Source of truth

- **`Anan-alsamaa/crm-app`, branch `001-yiji-crm-platform`** is the source of truth for the product. It is the **GitHub default branch** and the **merge target** for all stream/fix/deploy PRs (e.g. PRs #30 and #33 both based on `001`). The `crm-app-infra` worktree currently sits on it.
- `main` is a secondary/ops branch, not the product integration line.

---

## 9. Abandoned / experimental / duplicated / temporary

- **Duplicated:** the three external repos exist **twice** (`external-repos/*` and `downloads/*`) — identical remotes; one set is redundant.
- **Missing/abandoned config:** `d:/emad/firecrawl` is a configured working directory that **does not exist** on disk.
- **Temporary artifacts (in `crm-app` worktree root):** numerous `*.log` files (`admin-dev*.log`, `agent-a11y*.log`, `gateway-*.log`, `directus-*.log`, `widget-*.log`), `dump.rdb` (stray Redis dump), `test-results/`, and `stream details.txt` / `stream details`-style scratch notes — development debris, not part of the build.
- **Stale branches:** `deploy/linux-build-frontend` (its PR #31 already merged into `001`) and the `stream/*` branches remain after their work landed.
- **Experimental/rehearsal-only:** `ecosystem.hybrid.config.cjs`, `deploy/nginx.local.conf`, `.env.prod.smoke` are intentionally local/gitignored rehearsal files.

---

## 10. Docker architecture

- **Compose project:** `crm-app-infra` — config files `docker-compose.yml` + `docker-compose.override.yml` (the override pins **postgres:17-alpine** to match the existing v17 data volume; omitting it risks a v17/v16 incompatibility crash-loop).
- **Tiers:**
  - **Infra tier (always on):** `postgres`, `redis`, `directus` — no Compose profile, so a bare `docker compose up -d` starts only these.
  - **App tier (opt-in):** `socket-gateway`, `workers`, `ai-gateway` are gated behind the **`app` Compose profile** (PR #33). They start only with `docker compose --profile app up -d`. In the live hybrid setup they run under **PM2 instead**, so the Docker copies stay down to avoid an 8080 port clash and duplicate BullMQ consumers.
  - **Static tier:** a standalone `yiji-portals` (`nginx:alpine`) container serves the portal builds — **not** part of the `crm-app-infra` compose project.
- **Additional/alternative compose files:** `docker-compose.prod.yml` (full 6-service single-host path + bootstrap container) and `deploy/docker-compose.infra.yml` (infra-only prod tier).

---

## 11. Running containers

| Name                       | Image                  | Status           | Ports (host → container)                                         |
| -------------------------- | ---------------------- | ---------------- | ---------------------------------------------------------------- |
| `crm-app-infra-directus-1` | `directus/directus:11` | Up ~1h (healthy) | `8055 → 8055`                                                    |
| `crm-app-infra-postgres-1` | `postgres:17-alpine`   | Up ~1h (healthy) | `5433 → 5432`                                                    |
| `crm-app-infra-redis-1`    | `redis:7-alpine`       | Up ~1h (healthy) | `127.0.0.1:6380 → 6379`                                          |
| `yiji-portals`             | `nginx:alpine`         | Up ~2h           | `127.0.0.1:8090 → 8090` (agent), `127.0.0.1:8092 → 8092` (admin) |

- **Images present:** `directus/directus:11` (1.21 GB), `postgres:17-alpine` (400 MB), `redis:7-alpine` (57.8 MB), `nginx:alpine` (93.3 MB).
- **Volumes:** `crm-app-infra_postgres_data`, `crm-app-infra_redis_data`, `crm-app-infra_directus_uploads`.
- **Docker engine:** server `29.5.3`. No stopped containers; the app-tier services are not containerized here (run under PM2).

---

## 12. Container dependencies

- **`directus`** `depends_on`:
  - `postgres` — `condition: service_healthy`
  - `redis` — `condition: service_healthy`
- `postgres` and `redis` have **no** dependencies (base of the graph).
- `yiji-portals` (nginx) has **no** compose dependency — it serves static bundles only and calls the backends via baked `VITE_*` host URLs (CORS-allowed), so no reverse-proxy wiring locally.
- App-tier services (when enabled via the `app` profile) depend on the infra tier; under PM2 they connect to Postgres/Redis/Directus over their published host ports.

---

## 13. PostgreSQL usage

- **Image:** `postgres:17-alpine` (container `crm-app-infra-postgres-1`), host port **5433 → 5432**.
- **Role:** primary datastore behind **Directus**; holds the CRM schema/data (DB `yiji_crm`, user `directus`). Data persists in volume `crm-app-infra_postgres_data` (a v17 volume — hence the v17 image pin in the override).
- **Prod note:** the prod compose path uses **postgres:16** consistently on a fresh server; the 17/16 mismatch trap is dev-box-only (existing v17 dev volume).

---

## 14. Directus usage

- **Image:** `directus/directus:11` (container `crm-app-infra-directus-1`), port **8055**, healthy.
- **Role:** headless data layer / API + auth for the CRM. Backed by Postgres (data) and Redis (cache/realtime). Frontends point `VITE_DIRECTUS_URL=http://localhost:8055`.
- **In-repo support:** `directus/bootstrap` (containerized idempotent schema seed, runnable as a profile-gated `bootstrap` service), `directus/extensions`, `directus/snapshot`, and `directus/local` (local extension dev with its own `.env`).
- Uploads persist in volume `crm-app-infra_directus_uploads`.

---

## 15. Redis usage

- **Image:** `redis:7-alpine` (container `crm-app-infra-redis-1`), bound to **loopback only** at host port **6380 → 6379**.
- **Role:** Socket.IO Redis adapter (gateway fan-out/presence) and **BullMQ** queue backing the `workers` service; also Directus cache. Data persists in volume `crm-app-infra_redis_data`.
- A stray `dump.rdb` exists in the `crm-app` worktree root (development debris, not the container's volume).

---

## 16. PM2 processes

| id  | name             | status | restarts | mode | script                                         |
| --- | ---------------- | ------ | -------- | ---- | ---------------------------------------------- |
| 0   | `socket-gateway` | online | 1        | fork | `crm-app/services/socket-gateway/src/index.ts` |
| 1   | `ai-gateway`     | online | 1        | fork | `crm-app/services/ai-gateway/src/index.ts`     |
| 2   | `workers`        | online | 1        | fork | `crm-app/services/workers/src/index.ts`        |

- All three **online**, ~64m uptime, low restart counts. Run via `tsx` from the **`crm-app`** worktree.
- Config: committed `ecosystem.config.cjs` (prod) / gitignored `ecosystem.hybrid.config.cjs` (local rehearsal).
- Ports: `socket-gateway` → **8080** (Socket.IO) + **8081** (HTTP/job-producer); `ai-gateway` → **8085**; `workers` → no port.

---

## 17. Frontend applications and ports

| App            | Type              | Dev (Vite) | Rehearsal (nginx static)                 | Public           |
| -------------- | ----------------- | ---------- | ---------------------------------------- | ---------------- |
| `agent-portal` | React 18 + Vite   | 5173       | **8090** (`yiji-portals` → `/www/agent`) | —                |
| `admin-portal` | React 18 + Vite   | 5174       | **8092** (`yiji-portals` → `/www/admin`) | —                |
| `chat-widget`  | Preact embeddable | 5175       | (embedded)                               | **ngrok** → 5175 |

- **Baked frontend env** (`apps/*/.env.local`, gitignored): `VITE_DIRECTUS_URL=http://localhost:8055`, `VITE_SOCKET_URL=http://localhost:8080`, `VITE_AI_GATEWAY_URL=http://localhost:8085`, `VITE_JOB_PRODUCER_URL=http://localhost:8081` (admin), plus `VITE_AI_SVC_TOKEN` (admin/agent) and `VITE_WIDGET_JWT_SECRET` (widget) — **secret values present in those files, not reproduced here.**
- Widget `.env.local` points `VITE_SOCKET_URL` at the public ngrok origin for the tunnel test (revert to `localhost:8080` for normal dev).

---

## 18. Nginx configuration

- **Live container `yiji-portals`** uses **`crm-app/deploy/nginx.local.conf`** (local rehearsal, gitignored):
  - `:8090` → `/www/agent`, `:8092` → `/www/admin`; SPA fallback to `index.html`.
  - **Caching:** SPA shell (`/`) = `Cache-Control: no-cache`; content-hashed `/assets/*` = `public, max-age=31536000, immutable`.
  - Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) repeated per-location (nginx cancels server-level `add_header` inheritance once a location sets its own).
- **Prod edge config:** `deploy/nginx/yiji-crm.conf` (present in all 4 worktrees) — TLS edge that serves the three portals + reverse-proxies `api (8055)` / `ws (8080)` / `ai (8085)`, with full CSP + HSTS and the same SPA `no-cache` strategy (the subject of PR #30 / #33).

---

## 19. Ngrok configuration

- **Tunnel definition:** `crm-app-infra/ngrok-tunnels.yml` (gitignored) —
  - tunnel `widget`: `proto: http`, `addr: 5175`, reserved domain **`jeane-bootyless-undesigningly.ngrok-free.dev`**.
- **Auth/config:** the authtoken lives in the default `C:/Users/e.habibi/AppData/Local/ngrok/ngrok.yml`; ngrok must be started with **both** config files (lone tunnels file → `ERR_NGROK_4018`).
- Exposes the **chat widget** (Vite dev server on 5175) publicly. A diagnostic log `crm-app-infra/ngrok-diag.log` is also present.

---

## 20. Environment files discovered

> Each product worktree carries its own copy of the same env set (they're worktrees of one repo). Secret values are **not** reproduced.

**Per worktree (`crm-app`, `crm-app-infra`, `crm-app-frontend`, `crm-app-quality`):**

- `.env` — active local env (present in all but frontend has its own; gitignored, contains secrets).
- `.env.example` — committed template.
- `.env.prod` — production env (present in `crm-app` and `crm-app-infra`; secret-bearing).
- `.env.prod.example` — committed prod template.
- `directus/local/.env.example` — Directus extension-dev template (`crm-app/directus/local/.env` also present).

**Frontend app envs (gitignored, secret-bearing) — under `crm-app/apps/` and `crm-app-frontend/apps/`:**

- `admin-portal/.env.local`, `agent-portal/.env.local`, `chat-widget/.env.local` (the `VITE_*` build vars in §17).

**Local-rehearsal only (gitignored):**

- `crm-app/.env.prod.smoke` — prod smoke-test env.

**Key secrets to be aware of (locations only):** service tokens (`SVC_GATEWAY_TOKEN`, `SVC_WORKERS_TOKEN`, `SVC_AI_TOKEN`), `YIJI_JWT_SECRET` / `VITE_WIDGET_JWT_SECRET`, `VITE_AI_SVC_TOKEN`, and Postgres credentials live in the `.env` / `.env.prod` / `apps/*/.env.local` files above. These are gitignored but present in plaintext on disk.

---

## Appendix — collection method

Read-only commands used: `git worktree list`, `git -C <dir> {branch,remote,status,rev-list,log}`, `gh repo view`, `gh pr view/checks`, `docker {ps,images,compose ls,compose config,volume ls,version}`, `pm2 jlist/list`, and `find`/`Read` for config & env discovery. No write, build, merge, or container operations were performed as part of this audit.
