# Yiji CRM — production deployment (final architecture)

Single server, single base domain. Three tiers:

| Layer | Component                      | Runs as             | Listens (loopback)               |
| ----- | ------------------------------ | ------------------- | -------------------------------- |
| Infra | Postgres 16                    | Docker              | internal network only            |
| Infra | Redis 7                        | Docker              | `127.0.0.1:6379`                 |
| Infra | Directus 11                    | Docker              | `127.0.0.1:8055`                 |
| App   | socket-gateway                 | **PM2** (Node/tsx)  | `127.0.0.1:8080` + `8081` (http) |
| App   | ai-gateway                     | **PM2** (Node/tsx)  | `127.0.0.1:8085`                 |
| App   | workers                        | **PM2** (Node/tsx)  | — (BullMQ consumer)              |
| Edge  | agent + admin portals + widget | **nginx** (static)  | served on `:443`                 |
| Edge  | reverse proxy + TLS            | **nginx + certbot** | `:80` → `:443` public            |

Nothing but nginx (`:80`/`:443`) is exposed publicly. Postgres has no host port at
all; Redis and Directus bind only to `127.0.0.1` for the PM2 services + nginx.

Files: [`docker-compose.infra.yml`](./docker-compose.infra.yml) (infra tier),
[`../ecosystem.config.cjs`](../ecosystem.config.cjs) (PM2 apps),
[`nginx/yiji-crm.conf`](./nginx/yiji-crm.conf) (edge).

---

## 0. Prerequisites

- Linux host, Docker 24+ with the compose plugin, Node 20 + pnpm 9, nginx, certbot.
- A domain with these A/AAAA records pointing at the host:
  `agent. admin. widget. api. ws. ai.` (e.g. `agent.crm.example.com`).
- The three repos checked out side by side (the PM2 + build scripts assume this):
  `crm-app-infra/` (this), `crm-app-frontend/` (the SPAs), and PM2 runs the
  services from `crm-app-infra/services/*`.

## 1. Configure `.env.prod`

Copy `.env.example` → `.env.prod` (gitignored) and set **strong** secrets, then
set these values for THIS architecture (loopback infra + nginx domains):

```dotenv
NODE_ENV=production

# Directus — public URL is the nginx api. host; internal is the Docker loopback.
DIRECTUS_PUBLIC_URL=https://api.crm.example.com
DIRECTUS_INTERNAL_URL=http://127.0.0.1:8055
DIRECTUS_KEY=...                 # openssl rand -hex 32
DIRECTUS_SECRET=...              # openssl rand -hex 32
DIRECTUS_ADMIN_EMAIL=ops@crm.example.com
DIRECTUS_ADMIN_PASSWORD=...      # strong; not 123456

# Postgres (Docker, internal). DB creds are consumed by the compose.
DB_DATABASE=yiji_crm
DB_USER=yiji
DB_PASSWORD=...

# Redis (Docker, loopback) — what the PM2 services connect to.
REDIS_URL=redis://127.0.0.1:6379

# Service tokens (openssl rand -hex 24) — seeded by bootstrap, used by PM2 svcs.
SVC_GATEWAY_TOKEN=...
SVC_WORKERS_TOKEN=...
SVC_AI_TOKEN=...
YIJI_JWT_SECRET=...              # >=32 chars; signs customer widget tokens

# Ports — ai-gateway is 8085 in this architecture (NOT 8081/8091).
AI_GATEWAY_PORT=8085

# CORS — the operator portal origins (credentialed cookie auth).
CORS_ORIGIN=https://agent.crm.example.com,https://admin.crm.example.com

# Frontend build vars (baked into the SPA bundles at build time).
VITE_DIRECTUS_URL=https://api.crm.example.com
VITE_SOCKET_URL=https://ws.crm.example.com
VITE_AI_GATEWAY_URL=https://ai.crm.example.com

# Email (workers require a host), AI, commerce — as applicable.
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=Yiji Support <support@crm.example.com>
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
YIJI_API_URL=                    # empty → commerce uses the mock client
YIJI_API_KEY=
```

> **Removed by the security work (C-1):** `VITE_AI_SVC_TOKEN` is no longer read —
> delete it from `.env.prod`. The AI gateway now verifies the agent's Directus
> session server-side; no service token is shipped to the browser.

## 2. Bring up the infra tier (Docker)

```bash
docker compose -f deploy/docker-compose.infra.yml --env-file .env.prod up -d
# wait for Directus to report healthy, then apply schema/roles/service tokens:
docker compose -f deploy/docker-compose.infra.yml --env-file .env.prod run --rm bootstrap
```

## 3. Build the frontends (static)

The apps live in this same repo (self-contained), so build them from the repo
root. `build-frontend.sh` builds agent/admin/widget and strips the widget's dev
demo host page so the public widget host serves only the embeddable assets.

```bash
# From the repo root, with .env.prod's VITE_* exported (set -a; . .env.prod; set +a):
bash deploy/build-frontend.sh
# Point nginx at the built dist dirs (symlink or copy), e.g.:
sudo mkdir -p /srv/yiji
sudo ln -sfn "$PWD/apps/agent-portal/dist"  /srv/yiji/agent-portal/dist
sudo ln -sfn "$PWD/apps/admin-portal/dist"  /srv/yiji/admin-portal/dist
sudo ln -sfn "$PWD/apps/chat-widget/dist"   /srv/yiji/chat-widget/dist
```

> Rebuild whenever `VITE_*` (the domain) or the frontend code changes — those
> URLs are compiled into the bundle.
>
> ⚠️ `build-frontend.ps1` is a **Windows local-demo** helper only: it regenerates
> the widget host page and bakes `YIJI_JWT_SECRET` into it to mint a browser-side
> demo token. Never run it for a public deploy — that secret must stay server-side
> (only the gateway/storefront uses it). Use `build-frontend.sh` in production.

## 4. Start the Node services (PM2)

```bash
pnpm install --frozen-lockfile        # in crm-app-infra (services live here)
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup               # restart on reboot
pm2 status                            # socket-gateway, ai-gateway, workers → online
```

## 5. nginx + TLS (certbot)

```bash
sudo sed -i 's/crm\.example\.com/your.domain/g' deploy/nginx/yiji-crm.conf
sudo cp deploy/nginx/yiji-crm.conf /etc/nginx/sites-available/yiji-crm.conf
sudo ln -sf ../sites-available/yiji-crm.conf /etc/nginx/sites-enabled/
sudo certbot --nginx \
  -d agent.your.domain -d admin.your.domain -d widget.your.domain \
  -d api.your.domain   -d ws.your.domain    -d ai.your.domain
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Verify

```bash
curl -fsS https://api.your.domain/server/health     # {"status":"ok"|"warn"}
curl -fsS http://127.0.0.1:8081/ready               # socket-gateway readiness
curl -fsS http://127.0.0.1:8085/health              # ai-gateway
pm2 status
# Sign in at https://admin.your.domain and https://agent.your.domain.
```

## Operations

- **Update app code:** `git pull` → `pnpm install` → `pm2 reload all`. For
  frontend changes: re-run `bash deploy/build-frontend.sh` (nginx serves the new files).
- **Rotate service tokens:** update `.env.prod` → re-run the `bootstrap` step →
  `pm2 reload all`.
- **Backups:** `docker compose -f deploy/docker-compose.infra.yml exec postgres \
pg_dump -U "$DB_USER" -Fc "$DB_DATABASE" > backup.dump` (Postgres has no host
  port; dump through the container). Persist the `directus_uploads` volume too.
- **Logs:** `pm2 logs` (services); `docker compose -f deploy/docker-compose.infra.yml logs -f directus`.
- **Scale:** `pm2 scale socket-gateway 3` — the Redis adapter fans out across
  instances; enable nginx `ip_hash`/sticky on `ws.` if you rely on long-polling.

## Why this split

- **Docker for stateful infra** (Postgres/Redis/Directus): pinned images,
  one-command lifecycle, isolated data volumes, no host-level version drift.
- **PM2 for the Node services:** fast deploys (`reload` = zero-downtime), direct
  host logs/metrics, simple `git pull && reload`, no image rebuild per change.
- **nginx for the edge:** battle-tested static serving + TLS (certbot) + one
  public surface; everything else stays on loopback.
