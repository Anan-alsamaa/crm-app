# Staging Cutover Plan — mirror production

> **Date:** 2026-06-24 · **Plan only — do NOT deploy.**
> **Source of truth:** `main` @ `60f2581` (authoritative). Staging deploys this exact SHA.
> **Architecture mirrored:** the production "final architecture" (`deploy/README.md`): Docker infra tier + PM2 app tier + nginx/certbot edge. Staging uses the **same topology and the same files** as prod, with **isolated data, isolated domains, and isolated secrets**.
> **Golden rule:** staging must never share a database, Redis, volume, secret, or domain with production. Prefer a **separate host** (or at minimum a separate Docker compose project + distinct volumes + distinct loopback ports if co-located).

---

## 0. Strategy & isolation

| Aspect          | Production               | **Staging**                                                          |
| --------------- | ------------------------ | -------------------------------------------------------------------- |
| Branch / SHA    | `main`                   | **`main` @ `60f2581`** (same; pin the SHA)                           |
| Host            | prod host                | **separate VM** (recommended) or isolated project on a non-prod host |
| Base domain     | `crm.example.com`        | **`staging.crm.example.com`**                                        |
| Env file        | `.env.prod` (gitignored) | **`.env.staging`** (gitignored; fresh secrets)                       |
| Compose project | `yiji`                   | **`yiji-staging`** (`-p yiji-staging`) → distinct volumes/network    |
| Data            | real                     | **anonymized seed / sanitized restore** (no raw prod PII)            |
| TLS issuer      | LE production            | LE **staging** first (avoid rate limits), then real certs            |

Deploy the **single self-contained `crm-app` repo** at `60f2581` (the Linux `build-frontend.sh` removed the need for a sibling frontend checkout). The full-Docker alternative (`docker-compose.prod.yml`) exists but the canonical/decided model is the hybrid below.

---

## 1. Required infrastructure

- **1 Linux host** (staging), Docker 24+ with the compose plugin, **Node 20 + pnpm 9**, **nginx**, **certbot**. Sized small (staging load): 2 vCPU / 4 GB RAM / 40 GB disk is ample.
- **Docker (infra tier):** Postgres 16, Redis 7, Directus 11 — all on the host's loopback / internal Docker network only.
- **PM2 (app tier):** `socket-gateway`, `ai-gateway`, `workers` (Node/tsx via `ecosystem.config.cjs`).
- **nginx + certbot (edge):** static SPA serving + TLS termination + reverse proxy; the **only** public surface (`:80`/`:443`).
- **Outbound deps:** SMTP relay (staging mailbox or a catch-all like Mailpit), Gemini API key (a staging/quota-limited key), optional Yiji commerce API (leave empty → mock client).
- **DNS control** for the staging subdomains (below).
- Nothing but nginx is exposed publicly; Postgres has **no host port**, Redis/Directus bind `127.0.0.1` only.

## 2. Domains / subdomains

Six subdomains under the staging base, A/AAAA → the staging host:

| Subdomain                        | Serves                        | Backend (loopback) |
| -------------------------------- | ----------------------------- | ------------------ |
| `agent.staging.crm.example.com`  | agent portal (static SPA)     | nginx static       |
| `admin.staging.crm.example.com`  | admin portal (static SPA)     | nginx static       |
| `widget.staging.crm.example.com` | embeddable chat widget assets | nginx static       |
| `api.staging.crm.example.com`    | Directus REST/auth            | → `127.0.0.1:8055` |
| `ws.staging.crm.example.com`     | Socket.IO gateway             | → `127.0.0.1:8080` |
| `ai.staging.crm.example.com`     | AI + commerce gateway         | → `127.0.0.1:8085` |

Use **distinct staging hostnames** so cookies, CORS, and CSP never overlap with prod. Update three places to the staging domain:

- `deploy/nginx/yiji-crm.conf` — `server_name`s **and** the `Content-Security-Policy` `connect-src` (must list `api.`/`ws.`/`ai.` staging hosts + `wss://ws.…`).
- `.env.staging` — `DIRECTUS_PUBLIC_URL`, `CORS_ORIGIN`, and the `VITE_*` build URLs.
- Frontend rebuild (the `VITE_*` URLs are compiled into the bundle — §9).

## 3. TLS requirements

- **All six subdomains over HTTPS**; nginx redirects `:80 → :443`.
- Issue with **certbot --nginx** for all six names in one cert (SAN) or per-host.
- **Dry-run on Let's Encrypt staging first** (`--staging` / `--dry-run`) to avoid burning prod-LE rate limits during setup, then re-issue real certs.
- **HSTS** is set at the edge (nginx adds `Strict-Transport-Security` on the SPA shell). Do **not** enable HSTS preload on staging (staging hostnames shouldn't be preloaded).
- Edge already sets the security headers + per-location CSP (PR #30/#33). Confirm `nginx -t` passes after the domain `sed`.
- Internal hops (nginx→loopback services) are plain HTTP on `127.0.0.1` by design — never expose those ports.

## 4. PostgreSQL setup

- **Postgres 16** in Docker via `deploy/docker-compose.infra.yml`, project `yiji-staging` → **own volume** (`yiji-staging_postgres_data`), **no host port**.
- `.env.staging`: `DB_DATABASE=yiji_crm`, `DB_USER=yiji`, `DB_PASSWORD=<fresh strong>`. (Prod is Postgres **16**; the dev-box 17 pin is not used here.)
- **Data:** do **not** copy raw production data (contains customer PII). Either (a) bootstrap a clean schema + seed demo data, or (b) restore a **sanitized/anonymized** `pg_dump` of prod (scrub `contacts`/`messages` PII first).
- Backups: `docker compose -p yiji-staging -f deploy/docker-compose.infra.yml exec postgres pg_dump -U "$DB_USER" -Fc "$DB_DATABASE" > staging-pre-cutover.dump` (dump through the container — no host port).

## 5. Redis setup

- **Redis 7** in Docker (same compose), bound to **`127.0.0.1:6379`** on the staging host, **own volume** (`yiji-staging_redis_data`).
- `.env.staging`: `REDIS_URL=redis://127.0.0.1:6379`.
- Roles: Socket.IO Redis adapter (gateway fan-out/presence) + **BullMQ** queue (workers). A separate Redis instance from prod guarantees staging jobs/presence never cross into prod.
- If co-located with prod on one host, use a **different loopback port** (e.g. `127.0.0.1:6380`) and set `REDIS_URL` accordingly to avoid collision.

## 6. Directus setup

- **Directus 11** in Docker (same compose), `127.0.0.1:8055`, own `directus_uploads` volume.
- `.env.staging`: `DIRECTUS_PUBLIC_URL=https://api.staging.crm.example.com`, `DIRECTUS_INTERNAL_URL=http://127.0.0.1:8055`, fresh `DIRECTUS_KEY`/`DIRECTUS_SECRET` (`openssl rand -hex 32`), `DIRECTUS_ADMIN_EMAIL`/`DIRECTUS_ADMIN_PASSWORD` (strong; not `123456`).
- **Cookie auth (H-2) requires:** `CORS_CREDENTIALS=true`, and on HTTPS staging the refresh cookie is `Secure` + `SameSite=Lax` (cross-subdomain agent/admin → api). Verify these in the compose/Directus env.
- **Schema + roles + service tokens** via the containerized bootstrap (idempotent):
  ```
  docker compose -p yiji-staging -f deploy/docker-compose.infra.yml --env-file .env.staging up -d
  # wait for Directus healthy, then:
  docker compose -p yiji-staging -f deploy/docker-compose.infra.yml --env-file .env.staging run --rm bootstrap
  ```
- Seed a **staging demo vendor** (and demo contact/conversation) so the widget + portals have data to exercise.

## 7. Socket gateway setup (PM2)

- Runs under **PM2** from `ecosystem.config.cjs` (Node/tsx), `127.0.0.1:8080` (Socket.IO) + `8081` (http: health/metrics/webhooks + `/jobs/*`).
- `.env.staging`: `YIJI_JWT_SECRET` (≥32 chars; signs customer widget tokens — **fresh for staging**), `SVC_GATEWAY_TOKEN`, `REDIS_URL`, `DIRECTUS_INTERNAL_URL`, `CORS_ORIGIN` (`https://agent.staging…,https://admin.staging…`), `YIJI_WEBHOOK_SECRET` + `WEBHOOK_TOLERANCE_SEC`.
- **`WIDGET_CORS_ORIGIN` (open decision #5):** governs the Socket.IO origin and currently defaults to `*`. For staging, **set it explicitly** (even if to `https://widget.staging.crm.example.com` for a single-tenant staging) rather than relying on the silent `*` — this is the recommended fail-closed posture and a good place to validate the eventual prod decision.
- Start: `pnpm install --frozen-lockfile` → `pm2 start ecosystem.config.cjs` → `pm2 save && pm2 startup`. nginx proxies `ws.` → `127.0.0.1:8080` with WebSocket upgrade headers.

## 8. AI gateway setup (PM2)

- Runs under **PM2**, `127.0.0.1:8085` (`AI_GATEWAY_PORT=8085` — **not** 8081/8091; 8081 is the gateway's http port).
- `.env.staging`: `SVC_AI_TOKEN`, `DIRECTUS_INTERNAL_URL`, `REDIS_URL`, `GEMINI_API_KEY` (staging/quota key) + `GEMINI_MODEL=gemini-2.5-flash`, `CORS_ORIGIN` (operator origins), `YIJI_API_URL`/`YIJI_API_KEY` (leave **empty** → commerce uses the mock client; set only if exercising real commerce).
- **C-1/C-2 hardening (already in `main`):** the AI gateway verifies the agent's **Directus session server-side** (`verifyCaller`) and injects the commerce key server-side — **no** `VITE_AI_SVC_TOKEN` in the browser (delete it from any env). nginx proxies `ai.` → `127.0.0.1:8085`.
- **workers** (3rd PM2 process, no public port) consumes the BullMQ queue (imports, reports, email) — needs `SVC_WORKERS_TOKEN`, `REDIS_URL`, `DIRECTUS_INTERNAL_URL`, and `SMTP_*` (point at the staging mail relay).

## 9. Frontend deployment (static)

- Build from the repo root with the **staging** `VITE_*` exported, using the single-repo script:
  ```
  set -a; . .env.staging; set +a
  bash deploy/build-frontend.sh        # builds agent/admin/widget; strips the widget demo host page
  ```
  `VITE_DIRECTUS_URL=https://api.staging…`, `VITE_SOCKET_URL=https://ws.staging…`, `VITE_AI_GATEWAY_URL=https://ai.staging…`, `VITE_JOB_PRODUCER_URL` per the gateway http (`https://ws.staging…` `/jobs/*` or as configured). These are **compiled into the bundle** — rebuild on any domain or frontend change.
- Point nginx at the built `dist` dirs (symlink under `/srv/yiji-staging/...`).
- **Widget security:** `build-frontend.sh` deletes the dev demo host page (the in-browser JWT mint). In staging/prod the customer token must be **minted server-side** by the storefront/gateway with `YIJI_JWT_SECRET`; never ship that secret to the browser. **Never** use `build-frontend.ps1` for staging (it bakes the secret in).
- ⚠️ The two portals' Dockerfile/edge nginx serve the SPA shell `no-cache` + hashed `/assets/*` immutable (PR #30/#33) — already correct on `main`.

## 10. Verification checklist

**Infra & services**

- [ ] `docker compose -p yiji-staging ... ps` → postgres/redis/directus **healthy**.
- [ ] `curl -fsS https://api.staging.crm.example.com/server/health` → `{"status":"ok"|"warn"}`.
- [ ] `curl -fsS http://127.0.0.1:8081/ready` (gateway) and `http://127.0.0.1:8085/health` (ai) → 200.
- [ ] `pm2 status` → `socket-gateway`, `ai-gateway`, `workers` **online**, 0 restarts.
- [ ] Bootstrap ran idempotently (re-run = no-op); service tokens seeded.

**Edge & TLS**

- [ ] All six subdomains serve over **HTTPS**; `:80 → :443` redirect works; `nginx -t` clean.
- [ ] Cert covers all six SANs; not expired; chain valid (`curl -I` per host).
- [ ] CSP `connect-src` on the SPA shell lists the staging `api/ws/ai` hosts (no prod hosts).

**App behavior (security-sensitive — exercise the fixes that drove this convergence)**

- [ ] Admin + agent **login** (cookie auth) works across `admin.`/`agent.` (refresh-token cookie set, `me()` returns admin_access).
- [ ] **Realtime:** agent sees a customer message in real time (Socket.IO over `wss://ws.`).
- [ ] **IDOR guards:** a widget/customer cannot post message/typing/read into a foreign conversation id (server drops it). _(Covered by unit tests; smoke-verify with a crafted client if possible.)_
- [ ] **Attachment upload:** valid image uploads + previews; oversized/disallowed MIME rejected; filename sanitized.
- [ ] **AI panel:** summarize/suggest works (or degrades to 503 gracefully if Gemini key absent); commerce panel uses mock unless `YIJI_API_KEY` set; **no AI service token in the browser bundle** (grep the built JS for `SVC_AI`/`ai_` → none).
- [ ] **Workers:** an import/report job runs; an email lands in the staging mailbox.
- [ ] **Widget** loads from `widget.` host, connects via a **server-minted** token (not the stripped demo page).

**Hygiene**

- [ ] No staging component points at any **prod** DB/Redis/Directus/domain/secret.
- [ ] `pm2 logs` / `docker logs directus` clean of auth/CORS errors.

## 11. Rollback plan

Staging is **new and isolated**, so rollback is low-risk and never touches prod.

**A. Abort the staging cutover entirely**

1. `pm2 delete ecosystem.config.cjs` (or `pm2 delete socket-gateway ai-gateway workers`).
2. `docker compose -p yiji-staging -f deploy/docker-compose.infra.yml down` (keep volumes) — or `down -v` to discard staging data.
3. `sudo rm /etc/nginx/sites-enabled/yiji-crm-staging.conf && sudo nginx -t && sudo systemctl reload nginx`.
4. (Optional) revoke staging certs; remove staging DNS records.

- **Prod is unaffected** throughout — staging shares nothing with it.

**B. Roll back a bad staging deploy to a known-good SHA**

- App tier: `git checkout <prev-good-SHA>` → `pnpm install --frozen-lockfile` → `pm2 reload all` (zero-downtime). Re-`build-frontend.sh` if frontend changed.
- Data: restore the **pre-cutover dump** taken in §4: `pg_restore` into a fresh DB through the postgres container; restore the `directus_uploads` volume snapshot.
- Edge: revert `deploy/nginx/yiji-crm.conf` to the prior version → `nginx -t` → reload.

**C. Safety nets to capture before cutover (so B is possible)**

- [ ] `pg_dump -Fc` of the staging DB (and a snapshot of `directus_uploads`).
- [ ] Record the deployed SHA (`60f2581`) and the prior `pm2` SHA.
- [ ] Keep `.env.staging` backed up out-of-band (it holds the only copy of staging secrets).

> Because `main` is authoritative and immutable history, any staging state can be re-derived from `git checkout 60f2581` + bootstrap + seed — the durable artifacts to protect are the **`.env.staging` secrets** and any **seeded/anonymized data** you want to keep.

---

### Notes / dependencies on open items

- **Open decision #5 (`WIDGET_CORS_ORIGIN`)** — set explicitly in staging (don't rely on the `*` default); staging is the right place to validate the prod posture before deciding.
- **Open decision #7 (customer-jwt phone-only)** — no action needed for staging; the host must mint tokens with a valid phone.
- **GitHub default branch is still `001`** (behind `main`); ensure the staging checkout is **`main` @ `60f2581`**, not the default branch.
- This is a **plan only — nothing was deployed.**
