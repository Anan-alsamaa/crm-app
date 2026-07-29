# Current Runtime State — Yiji CRM (Verified)

> **Captured:** 2026-06-24, live on this Windows 10 host. **Verified facts only** — every line below was confirmed by a live probe (`docker ps`/`inspect`, `pm2 jlist`, `Get-NetTCPConnection`, HTTP requests, `ngrok` API, `git worktree list`, file timestamps). Inferences are labeled as such. No code/config was modified.

---

## 1. Running containers (verified — `docker ps` / `docker inspect`)

| Container                  | Image                  | Status              | Published ports                              |
| -------------------------- | ---------------------- | ------------------- | -------------------------------------------- |
| `crm-app-infra-directus-1` | `directus/directus:11` | Up 2h **(healthy)** | `0.0.0.0:8055→8055`, `[::]:8055→8055`        |
| `crm-app-infra-postgres-1` | `postgres:17-alpine`   | Up 2h **(healthy)** | `0.0.0.0:5433→5432`, `[::]:5433→5432`        |
| `crm-app-infra-redis-1`    | `redis:7-alpine`       | Up 2h **(healthy)** | `127.0.0.1:6380→6379`                        |
| `yiji-portals`             | `nginx:alpine`         | Up 2h               | `127.0.0.1:8090→8090`, `127.0.0.1:8092→8092` |

- **Active Compose project:** `crm-app-infra` — config `docker-compose.yml` + `docker-compose.override.yml` (status `running(3)`). The override pins `postgres:17-alpine`.
- **`yiji-portals` is NOT part of the Compose project** — it is a standalone container.

---

## 2. Running PM2 services (verified — `pm2 jlist`)

| Service          | Status     | PID   | Uptime  | Restarts | Working dir                       |
| ---------------- | ---------- | ----- | ------- | -------- | --------------------------------- |
| `socket-gateway` | **online** | 27688 | 106 min | 1        | `crm-app/services/socket-gateway` |
| `ai-gateway`     | **online** | 19956 | 106 min | 1        | `crm-app/services/ai-gateway`     |
| `workers`        | **online** | 26552 | 106 min | 1        | `crm-app/services/workers`        |

- All three run from the **`crm-app`** worktree via `tsx` (`src/index.ts`).
- **`workers` env: `HEALTH_PORT` unset, `PORT` unset** (verified from pm2 env) → no workers health port is exposed (see §3, port 8083).

---

## 3. Active ports (verified — `Get-NetTCPConnection -State Listen` + HTTP probe)

| Port | Listening | Bind address                                                      | HTTP probe                                      | Service                                            |
| ---- | --------- | ----------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| 8055 | ✅        | docker-published `0.0.0.0` + `[::]` (host listener seen on `::1`) | **200** (`/server/health`)                      | Directus                                           |
| 8080 | ✅        | `::` (all)                                                        | **200** (`/socket.io/?EIO=4&transport=polling`) | socket-gateway (Socket.IO)                         |
| 8081 | ✅        | **`0.0.0.0` (all interfaces)**                                    | **200** (`/health`)                             | gateway http (health/metrics/webhooks + `/jobs/*`) |
| 8085 | ✅        | **`0.0.0.0` (all interfaces)**                                    | **200** (`/health`)                             | ai-gateway                                         |
| 8083 | ❌        | —                                                                 | connection refused                              | (workers health — not exposed)                     |
| 8082 | ❌        | —                                                                 | —                                               | (not in use)                                       |
| 8090 | ✅        | `127.0.0.1`                                                       | **200** (`/health`)                             | nginx → agent portal                               |
| 8092 | ✅        | `127.0.0.1`                                                       | **200** (`/health`)                             | nginx → admin portal                               |
| 5433 | ✅        | `::` (all)                                                        | —                                               | Postgres (host→container)                          |
| 6380 | ✅        | `127.0.0.1`                                                       | —                                               | Redis (host→container)                             |
| 5173 | ❌        | —                                                                 | —                                               | (agent Vite dev — not running)                     |
| 5174 | ❌        | —                                                                 | —                                               | (admin Vite dev — not running)                     |
| 5175 | ✅        | `::` (all)                                                        | (tunnelled, see §5)                             | chat-widget Vite dev                               |
| 4040 | ✅        | `127.0.0.1`                                                       | —                                               | ngrok local web/API                                |

**Verified observations:**

- The agent/admin Vite dev servers (5173/5174) are **down** — those portals are served as static builds via nginx instead.
- `8081` (gateway http) and `8085` (ai-gateway) bind **`0.0.0.0`** (all interfaces), not loopback.

---

## 4. Nginx configuration (verified — `docker inspect yiji-portals` mounts)

The running `yiji-portals` container uses these **read-only bind mounts**:

| Host path                         | Container path                   |
| --------------------------------- | -------------------------------- |
| `crm-app/deploy/nginx.local.conf` | `/etc/nginx/conf.d/default.conf` |
| `crm-app/apps/admin-portal/dist`  | `/www/admin`                     |
| `crm-app/apps/agent-portal/dist`  | `/www/agent`                     |

- Command: `nginx -g daemon off;`.
- **The served static builds come from the `crm-app` worktree** (`apps/*/dist`), serving agent on **8090** and admin on **8092**.
- The active config is the **local rehearsal** `nginx.local.conf` (static-only; no API reverse-proxy — portals call the backends directly via baked `VITE_*` URLs). The prod edge config `deploy/nginx/yiji-crm.conf` is **not** the one running here.

**Served build freshness (verified file timestamps):**

- `admin-portal/dist/index.html` — built **2026-06-23 16:38:50**
- `agent-portal/dist/index.html` — built **2026-06-23 16:38:50**
- `chat-widget/dist/*` — built 2026-06-23 16:38:37 (present but the widget is served via Vite dev, not from this dist — see §5)

---

## 5. Ngrok configuration (verified — process + `localhost:4040/api/tunnels`)

- **ngrok process: RUNNING** (pids 15696, 16016).
- **Active tunnel (live from the ngrok API):** `https://jeane-bootyless-undesigningly.ngrok-free.dev → http://localhost:5175` (proto `https`).
- Port **5175 is owned by a Vite dev server in the `crm-app-frontend` worktree** (verified command line): `…\crm-app-frontend\apps\chat-widget\…\vite.js --port 5175`.

---

## 6. Current deployment topology (verified composition)

```
Docker (compose project crm-app-infra, configs in crm-app-infra worktree):
   postgres:17 (5433)   redis:7 (6380)   directus:11 (8055)        [healthy]
   + standalone nginx `yiji-portals` (8090 agent / 8092 admin)

PM2 (from crm-app worktree):
   socket-gateway (8080 + 8081)   ai-gateway (8085)   workers (no port)   [online]

Static portals (nginx, from crm-app worktree builds):
   agent  -> crm-app/apps/agent-portal/dist  (built 2026-06-23 16:38)
   admin  -> crm-app/apps/admin-portal/dist  (built 2026-06-23 16:38)

Widget (Vite dev, from crm-app-frontend worktree):
   chat-widget :5175  --ngrok-->  jeane-bootyless-undesigningly.ngrok-free.dev
```

This is the **HYBRID** model (Docker infra + PM2 services + nginx static + ngrok widget), **confirmed live**.

---

## 7. Which branch is currently deployed (verified — `git worktree list`)

**The running system spans THREE different worktrees/branches:**

| Running component           | Source worktree           | Branch                               | HEAD                                   |
| --------------------------- | ------------------------- | ------------------------------------ | -------------------------------------- |
| Compose config (infra tier) | `crm-app-infra`           | `001-yiji-crm-platform`              | `ef31b01`                              |
| PM2 app services            | `crm-app`                 | **`main`**                           | `d1f210d` (committed 2026-06-24 09:44) |
| nginx static portals        | `crm-app` (`apps/*/dist`) | **`main`**                           | built 2026-06-23 16:38                 |
| Widget (Vite 5175)          | `crm-app-frontend`        | **`fix/e2e-tickets-first-response`** | `80a58cf`                              |

**There is no single "deployed branch."** The application code in production paths runs from **`main`** (backend + portals) and **`fix/e2e-tickets-first-response`** (widget). The infra tier's Compose config is from `001`, but those are official images (branch-independent).

---

## 8. Mismatches between deployment docs/intent and reality (verified)

1. **Source-of-truth branch is not what's running.** The documented integration/source-of-truth + GitHub **default branch is `001-yiji-crm-platform`**, but **no running app component is from `001`** — backend + portals are from `main`, the widget from `fix/e2e-tickets-first-response`. _(Verified via worktree branches + PM2 cwd + nginx mounts + 5175 cmdline.)_

2. **Deployment is split across three branches/worktrees**, whereas the hybrid runbook (`deploy/README.md`, `deploy-model-hybrid` memory) describes one coherent stack. _(Verified.)_

3. **Served portal bundles predate the current `main` HEAD.** `dist/index.html` for both portals was built **2026-06-23 16:38**, while `main` HEAD was committed **2026-06-24 09:44** — i.e. the served static builds were last produced _before_ the current HEAD commit, so they do not necessarily reflect current `main`. _(Verified timestamps; the HEAD commit is an ops/docs refactor, so functional impact is likely nil — but the staleness is a fact.)_

4. **The running PM2 config is not the documented local hybrid file.** `deploy-model-hybrid` memory states local services run via `ecosystem.hybrid.config.cjs`, which sets `workers HEALTH_PORT=8083`. Live: **`HEALTH_PORT` is unset and 8083 is not listening**, matching the committed `ecosystem.config.cjs` (no health port). So the running config is **not** the hybrid file. _(Verified from pm2 env + port probe + both config files.)_

5. **App services bind all interfaces, not loopback.** `8081` (gateway http) and `8085` (ai-gateway) listen on **`0.0.0.0`**; the hybrid/prod intent (`deploy-model-hybrid` memory, `deploy/README.md`) is `127.0.0.1`. On this host they are reachable beyond loopback. _(Verified `LocalAddress` from `Get-NetTCPConnection`.)_

**No mismatch found** in: container set, health status, Directus/gateway/ai-gateway responsiveness (all 200), Redis/Postgres loopback binding, the active nginx config path, or the ngrok tunnel target — all matched expectations.

---

### Verification method

`docker ps` / `docker inspect yiji-portals` / `docker compose ls`; `pm2 jlist` (status, cwd, env); `Get-NetTCPConnection -State Listen` (ports + bind address); `Invoke-WebRequest` HTTP probes; `Get-Process`/`Win32_Process` (5175 owner); `Invoke-RestMethod http://localhost:4040/api/tunnels` (ngrok); `git worktree list` + `git log`; file `LastWriteTime` for build freshness. Captured 2026-06-24. Read-only.
