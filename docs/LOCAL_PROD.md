# Local production-like run (no Docker)

This machine has no Docker, so the production stack (`docker-compose.prod.yml`)
can't run here. Instead we run the same processes natively under **pm2** with
`NODE_ENV=production`, real generated secrets, Redis-backed Directus cache,
built static portals, autorestart, and per-process memory caps. This mirrors
production behaviour without containers.

## Topology (all on localhost)

| Process        | Port | Notes                                                                |
| -------------- | ---- | -------------------------------------------------------------------- |
| PostgreSQL     | 5432 | native service, db `yiji_crm` (directus/directus)                    |
| Redis          | 6390 | standalone (pm2 can't supervise a Windows `.exe`)                    |
| Directus       | 8055 | Redis cache + websockets, `directus@11` (pinned in `.directus-prod`) |
| socket-gateway | 8080 | NODE_ENV=production, Redis adapter                                   |
| ai-gateway     | 8091 | NODE_ENV=production, Gemini `gemini-2.5-flash`                       |
| workers        | 8090 | NODE_ENV=production, BullMQ                                          |
| agent-portal   | 5173 | built static SPA via `serve`                                         |
| admin-portal   | 5174 | built static SPA via `serve`                                         |
| chat-widget    | 5175 | built IIFE bundle + host page via `serve`                            |

## Start / stop

```pwsh
pwsh ./start-prod.ps1     # Redis + pm2 stack
pm2 status                # health
pm2 logs                  # tail logs
pwsh ./stop-prod.ps1      # stop everything (Postgres left running)
```

Config lives in `ecosystem.config.cjs`; secrets in `.env.prod` (gitignored).

## Credentials & data

- Admin (Directus + admin portal): `e.habibi@anan.sa` / `123456` — **change for real prod.**
- Agent (agent portal): `e2e.agent@example.com` / `123456`.
- Demo vendor `demo-vendor` + seeded conversations exist for testing.

## Rebuilding the portals

`VITE_*` are baked at build time from the **root** `crm-app-frontend/.env`
(gitignored). After changing a portal or those vars:

```pwsh
cd ../crm-app-frontend
pnpm --filter @yiji/agent-portal build
pnpm --filter @yiji/admin-portal build
pnpm --filter @yiji/chat-widget build   # then re-create dist/index.html host page
```

`serve` picks up the new files automatically (no pm2 restart needed).

## Notes & gotchas

- **RAM:** this box has ~8 GB. The stack fits at rest (~1.2 GB) but running
  Vite builds or a Playwright/Chromium session _at the same time_ can OOM it.
  Build/verify with the stack briefly stopped, or one heavy task at a time.
  pm2 `max_memory_restart` caps each process so one leak can't take the box down.
- **Redis must be up first** — Directus/gateway/ai-gateway hard-depend on it and
  will crash-loop (visible as climbing `↺` in `pm2 status`) until it is.
- **Strict CORS:** `CORS_ORIGIN` is an explicit allow-list (the three portal
  origins), not `*`. The gateway splits it for Socket.IO; the ai-gateway for
  Fastify CORS.
- **Real prod:** use `docker-compose.prod.yml` on a Docker host with a managed
  Postgres/Redis, strong admin password, TLS, and a CDN for the static portals.
