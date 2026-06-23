# Yiji CRM — Hybrid Deployment Runbook (Docker infra + PM2 app + nginx)

The recommended single-host production setup. It avoids building/pushing Docker
images for the app code (deploys are `git pull && pnpm build && pm2 reload`) while
keeping the stable infrastructure in well-tested official containers.

> Docker is **not** heavy on a Linux server — containers share the host kernel
> (no VM). The heaviness you saw locally was Docker **Desktop on Windows** (a full
> WSL2 VM). This runbook targets a Linux server.

## Architecture

| Layer | Component             | Runs as                         | Listens on (loopback)                                              |
| ----- | --------------------- | ------------------------------- | ------------------------------------------------------------------ |
| Infra | Postgres 16           | Docker (`postgres:16-alpine`)   | internal network only                                              |
| Infra | Redis 7               | Docker (`redis:7-alpine`)       | `127.0.0.1:6379`                                                   |
| Infra | Directus 11           | Docker (`directus/directus:11`) | `127.0.0.1:8055`                                                   |
| App   | socket-gateway        | **PM2** (Node/tsx)              | `127.0.0.1:8080` (socket) + `8081` (http: /health,/jobs,/webhooks) |
| App   | ai-gateway            | **PM2** (Node/tsx)              | `127.0.0.1:8085`                                                   |
| App   | workers               | **PM2** (Node/tsx)              | no port (BullMQ consumer)                                          |
| Edge  | agent + admin portals | **nginx** (static SPA)          | served + TLS                                                       |
| Edge  | reverse proxy + TLS   | **nginx + certbot**             | `:443` public                                                      |

> **Port note:** the gateway binds `PORT` _and_ `PORT+1`. With `PORT=8080` it owns
> 8080 + 8081, so ai-gateway is moved to **8085** here to avoid a host clash
> (in Docker they don't clash; on one host with PM2 they would).

Public DNS (all HTTPS, terminated at nginx):

- `agent.yourcompany.com` → agent portal (static)
- `admin.yourcompany.com` → admin portal (static)
- `directus.yourcompany.com` → Directus (proxy → 8055)
- `gateway.yourcompany.com` → socket-gateway socket (proxy → 8080) + `/jobs`,`/webhooks` (proxy → 8081)
- `ai.yourcompany.com` → ai-gateway (proxy → 8085)

---

## 0. Prerequisites (Ubuntu/Debian server)

```bash
# Docker engine (NOT Docker Desktop)
curl -fsSL https://get.docker.com | sh

# Node 20 + pnpm (corepack) + PM2 + nginx + certbot
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
sudo corepack enable && corepack prepare pnpm@latest --activate
sudo npm i -g pm2

# A 2–4 GB VPS is enough (~600 MB–1 GB idle).
```

Clone the repo to `/opt/yiji/crm-app` (use `main`):

```bash
sudo mkdir -p /opt/yiji && cd /opt/yiji
git clone https://github.com/Anan-alsamaa/crm-app.git
cd crm-app && git checkout main
pnpm install --frozen-lockfile     # full install (tsx is the runtime)
```

---

## 1. Secrets / env

```bash
cp .env.prod.example .env.prod
bash scripts/gen-prod-secrets.sh    # fills DIRECTUS_KEY/SECRET, YIJI_JWT_SECRET, SVC_* tokens, DB_PASSWORD
chmod 600 .env.prod                 # never commit
```

Then fill the `[PROVIDE]` values in `.env.prod` (admin email/password, public URLs,
`CORS_ORIGIN`, SMTP, `GEMINI_API_KEY`). **For this hybrid layout, set the
service-to-service URLs to loopback** (the PM2 services are on the host, not the
Docker network):

```dotenv
DIRECTUS_PUBLIC_URL=https://directus.yourcompany.com
DIRECTUS_INTERNAL_URL=http://127.0.0.1:8055
REDIS_URL=redis://127.0.0.1:6379
AI_GATEWAY_URL=http://127.0.0.1:8085
DB_HOST=127.0.0.1           # host tools (the bootstrap) reach the PUBLISHED port; the Directus *container* uses 'postgres' (hardcoded in its docker run, step 2)
CORS_ORIGIN=https://agent.yourcompany.com,https://admin.yourcompany.com
# portal build args (baked, non-secret):
VITE_DIRECTUS_URL=https://directus.yourcompany.com
VITE_SOCKET_URL=https://gateway.yourcompany.com
VITE_AI_GATEWAY_URL=https://ai.yourcompany.com
VITE_JOB_PRODUCER_URL=https://gateway.yourcompany.com
```

---

## 2. Infrastructure (Docker, `docker run`)

```bash
set -a && . ./.env.prod && set +a          # load secrets into this shell
docker network create yiji-net 2>/dev/null || true

# Postgres — Directus reaches it by name over the network; the loopback publish
# lets the host-run bootstrap (step 3) open its direct pg connection for raw SQL.
docker run -d --name postgres --network yiji-net --restart unless-stopped \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_DB="$DB_DATABASE" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -v postgres_data:/var/lib/postgresql/data \
  --health-cmd="pg_isready -U $DB_USER -d $DB_DATABASE" --health-interval=10s \
  postgres:16-alpine

# Redis — on the network AND published to loopback (PM2 services + workers use it)
docker run -d --name redis --network yiji-net --restart unless-stopped \
  -p 127.0.0.1:6379:6379 -v redis_data:/data \
  redis:7-alpine redis-server --appendonly yes --save 60 1000

# Directus — on the network, published to loopback; reaches pg/redis by name
docker run -d --name directus --network yiji-net --restart unless-stopped \
  -p 127.0.0.1:8055:8055 \
  -e KEY="$DIRECTUS_KEY" -e SECRET="$DIRECTUS_SECRET" \
  -e ADMIN_EMAIL="$DIRECTUS_ADMIN_EMAIL" -e ADMIN_PASSWORD="$DIRECTUS_ADMIN_PASSWORD" \
  -e PUBLIC_URL="$DIRECTUS_PUBLIC_URL" \
  -e DB_CLIENT=pg -e DB_HOST=postgres -e DB_PORT=5432 \
  -e DB_DATABASE="$DB_DATABASE" -e DB_USER="$DB_USER" -e DB_PASSWORD="$DB_PASSWORD" \
  -e REDIS="redis://redis:6379" \
  -e RATE_LIMITER_ENABLED=true -e RATE_LIMITER_STORE=redis -e RATE_LIMITER_REDIS="redis://redis:6379" \
  -e CACHE_ENABLED=true -e CACHE_STORE=redis -e CACHE_AUTO_PURGE=true \
  -e WEBSOCKETS_ENABLED=true \
  -e CORS_ENABLED=true -e CORS_ORIGIN="$CORS_ORIGIN" -e CORS_CREDENTIALS=true \
  -e REFRESH_TOKEN_COOKIE_SAME_SITE="${REFRESH_TOKEN_COOKIE_SAME_SITE:-lax}" \
  -e REFRESH_TOKEN_COOKIE_SECURE=true \
  -v directus_uploads:/directus/uploads \
  -v "$PWD/directus/extensions:/directus/extensions" \
  directus/directus:11

# wait for health
until curl -sf http://127.0.0.1:8055/server/health >/dev/null; do sleep 2; done; echo "directus up"
```

> **Cookie auth (H-2):** `CORS_CREDENTIALS=true` + `REFRESH_TOKEN_COOKIE_SECURE=true`
> are required — the portals hold the access token in memory and refresh from an
> httpOnly cookie. If the portals live on a **different registrable domain** than
> Directus, set `REFRESH_TOKEN_COOKIE_SAME_SITE=none`.

---

## 3. Directus bootstrap (schema + roles + flows, then seed)

Apply the collections/relations/roles/flows the app expects (idempotent). The
bootstrap (`@yiji/directus-bootstrap`) logs in as the Directus admin **and** opens a
direct Postgres connection for raw constraint SQL, so it reads `DIRECTUS_INTERNAL_URL`,
`DIRECTUS_ADMIN_EMAIL` / `DIRECTUS_ADMIN_PASSWORD`, and `DB_*` from the environment —
all already in `.env.prod` (with `DB_HOST=127.0.0.1` from step 1, so it reaches the
published Postgres port from the host). It's a workspace package — no separate
install/`.env` file needed:

```bash
set -a && . ./.env.prod && set +a
pnpm --filter @yiji/directus-bootstrap apply     # schema + roles + flows (idempotent; safe to re-run each deploy)
pnpm --filter @yiji/directus-bootstrap verify    # optional: assert the role/permission matrix
```

Start production with **real data empty** — do NOT run `seed:demo` (it creates the
demo vendor/agent/conversations for local testing).

---

## 4. App services (PM2)

Create `ecosystem.config.cjs` in the repo root:

```js
// Run the three Node services under PM2. Env is inherited from the shell
// (source .env.prod before `pm2 start`); only per-service overrides are set here.
module.exports = {
  apps: [
    {
      name: 'socket-gateway',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @yiji/socket-gateway start',
      interpreter: 'none', // pnpm is directly executable
      env: { NODE_ENV: 'production', PORT: '8080', OTEL_SERVICE_NAME: 'socket-gateway' },
    },
    {
      name: 'ai-gateway',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @yiji/ai-gateway start',
      interpreter: 'none',
      env: { NODE_ENV: 'production', PORT: '8085', OTEL_SERVICE_NAME: 'ai-gateway' },
    },
    {
      name: 'workers',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @yiji/workers start',
      interpreter: 'none',
      env: { NODE_ENV: 'production', OTEL_SERVICE_NAME: 'workers' },
    },
  ],
};
```

Start them with the secrets loaded into the environment:

```bash
set -a && . ./.env.prod && set +a
pm2 start ecosystem.config.cjs
pm2 save                      # persist across reboots
pm2 startup                   # run the printed command (systemd boot hook)

pm2 list
curl -sf http://127.0.0.1:8081/health && echo " gateway ok"   # gateway HTTP = PORT+1
```

> The services validate `.env.prod` with Zod at boot and **fail fast** on a
> missing/placeholder secret, a `*` admin CORS origin, or a short JWT secret.
> `pm2 logs socket-gateway` shows the exact rejected key if it won't start.

---

## 5. Portals (static build)

```bash
set -a && . ./.env.prod && set +a   # VITE_* are read at build time
pnpm --filter @yiji/agent-portal --filter @yiji/admin-portal build
# outputs: apps/agent-portal/dist , apps/admin-portal/dist
sudo mkdir -p /var/www/agent /var/www/admin
sudo cp -r apps/agent-portal/dist/* /var/www/agent/
sudo cp -r apps/admin-portal/dist/* /var/www/admin/
```

The **chat widget** is embedded on vendor sites: `pnpm --filter @yiji/chat-widget build`
produces a single IIFE bundle **`apps/chat-widget/dist/yiji-chat-widget.js`** (exposing
`window.YijiChat`) plus a demo `index.html`. Host the `.js` on any static URL/CDN and
give vendors the `<script>` snippet (it connects to `gateway.yourcompany.com`).

---

## 6. nginx (static SPAs + reverse proxy + TLS)

`/etc/nginx/sites-available/yiji` (symlink into `sites-enabled`, then `nginx -t && systemctl reload nginx`):

```nginx
# Portals — SPA fallback + the security headers the official portal image sets
# (apps/*/Dockerfile). Keep these in parity with that nginx config.
server {
  server_name agent.yourcompany.com;
  root /var/www/agent; index index.html;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  location = /health { return 200 "ok"; add_header Content-Type text/plain; }
  location / { try_files $uri $uri/ /index.html; }
}
server {
  server_name admin.yourcompany.com;
  root /var/www/admin; index index.html;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  location = /health { return 200 "ok"; add_header Content-Type text/plain; }
  location / { try_files $uri $uri/ /index.html; }
}

# Directus
server {
  server_name directus.yourcompany.com;
  client_max_body_size 12m;                       # >= ATTACHMENT_MAX_BYTES
  location / { proxy_pass http://127.0.0.1:8055; proxy_set_header Host $host;
               proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Forwarded-For $remote_addr; }
}

# socket-gateway — WebSocket on /, admin/webhook HTTP on /jobs + /webhooks
server {
  server_name gateway.yourcompany.com;
  location /jobs/    { proxy_pass http://127.0.0.1:8081; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
  location /webhooks/{ proxy_pass http://127.0.0.1:8081; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
  location / {                                     # Socket.IO (ws upgrade)
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
    proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 3600s;                      # long-lived sockets
  }
}

# ai-gateway
server {
  server_name ai.yourcompany.com;
  location / { proxy_pass http://127.0.0.1:8085; proxy_set_header Host $host;
               proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Forwarded-For $remote_addr; }
}
```

> Do **not** expose `/metrics` or `/debug/*` (also on the gateway HTTP port) — the
> blocks above only proxy `/jobs/` and `/webhooks/`, keeping the rest internal.

TLS via Let's Encrypt (auto-edits the server blocks to add 443 + redirect):

```bash
sudo certbot --nginx -d agent.yourcompany.com -d admin.yourcompany.com \
  -d directus.yourcompany.com -d gateway.yourcompany.com -d ai.yourcompany.com
```

---

## 7. Smoke test

```bash
curl -sf https://directus.yourcompany.com/server/health        # {"status":"ok"}
curl -sf https://gateway.yourcompany.com/jobs/ -o /dev/null -w '%{http_code}\n'  # 401/405 (auth-gated, reachable)
# Browser: log into https://agent.yourcompany.com, open a conversation with an
# image attachment → it renders as a thumbnail + opens in the lightbox + downloads.
# Send a widget message from a test embed → it arrives in the agent inbox.
```

---

## 8. Updates & rollback

```bash
# Deploy a new version (no image builds):
cd /opt/yiji/crm-app && git pull origin main && pnpm install --frozen-lockfile
set -a && . ./.env.prod && set +a
pm2 reload ecosystem.config.cjs                                   # zero-downtime app reload
pnpm --filter @yiji/agent-portal --filter @yiji/admin-portal build
sudo cp -r apps/agent-portal/dist/* /var/www/agent/ && sudo cp -r apps/admin-portal/dist/* /var/www/admin/

# Rollback: git checkout v1.0.0 (the tag) && repeat. Data is in the Docker volumes.

# Infra upgrades (rare): docker pull directus/directus:11 && docker rm -f directus && <re-run step 2 directus>
# Postgres/Redis data persist in the named volumes (postgres_data, redis_data, directus_uploads).
```

### Backups

- DB: `docker exec postgres pg_dump -U "$DB_USER" "$DB_DATABASE" | gzip > backup-$(date +%F).sql.gz`
- Uploads: `docker run --rm -v directus_uploads:/d -v "$PWD":/b alpine tar czf /b/uploads-$(date +%F).tgz -C /d .`

---

## Footprint

~600 MB–1 GB idle (Postgres ~150 MB, Directus ~200 MB, 3 Node services ~100 MB
each, Redis/nginx negligible). Comfortable on a 2–4 GB Linux VPS; scale the gateway
with `pm2 scale socket-gateway 2` once you outgrow one core (Redis adapter makes it
horizontal-safe).
