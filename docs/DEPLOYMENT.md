# Deploying Yiji CRM

This is the **opinionated, step-by-step** path to a running production instance.
For the exhaustive reference (every env var, observability, security checklist,
backups) see [PRODUCTION.md](./PRODUCTION.md) — this guide tells you _what to do
in what order_ and links there for detail.

## Which target should I use?

| Target                                            | Use it when                                                                      | Effort    |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | --------- |
| **Single host (Docker Compose)**                  | **Recommended default.** Internal support-team CRM, one org, bounded user count. | ~1 hour   |
| Managed containers (ECS/Cloud Run/Container Apps) | You already live in a cloud and want managed scaling/patching.                   | ~half day |
| Kubernetes                                        | You already run a cluster and have the ops muscle for it.                        | ~1+ day   |

**Recommendation:** start on a **single host**. Yiji CRM is an internal,
operator-facing CRM — a bounded number of agents/admins, not public web scale.
The stack is already built for `docker-compose.prod.yml`, and because the
realtime layer coordinates through Redis you can still scale out **on one box**
(`--scale socket-gateway=3 --scale workers=2`) before you ever need an
orchestrator. Reach for managed containers or Kubernetes only when a single host
genuinely can't hold the load, or when org policy mandates the platform — both
add real operational tax (secrets, ingress, LB, rollout tooling) that a single
host gives you for free here. The "graduating" section at the bottom covers the
move when you get there.

The rest of this guide is the single-host path.

---

## 1. Prerequisites

- A Linux host (2 vCPU / 4 GB RAM is plenty to start) with **Docker 24+** and the
  **compose plugin**.
- A domain you control, with five sub-domains pointed (A/AAAA) at the host:
  `agent.`, `admin.`, `api.`, `ws.`, `ai.` — e.g. `agent.crm.example.com`.
- Outbound SMTP credentials (notifications + scheduled reports require them).
- Optional: a `GEMINI_API_KEY` (AI features degrade to a clean `503` without it).

## 2. Get the code + images

```bash
git clone <repo> && cd crm-app
git checkout 001-yiji-crm-platform   # or your release tag
```

You can either **pull pre-built images** from the registry (CI publishes them to
GHCR on every tagged release via `.github/workflows/deploy.yml`) or **build
locally**. To build locally:

```bash
docker compose -f docker-compose.prod.yml build
```

> The portal images bake their public URLs at **build** time (`VITE_*` are
> compile-time, client-visible — never secrets). If you pull pre-built images,
> they must have been built with _your_ public URLs. If in doubt, build locally
> with the env file from step 3 in place.

## 3. Configure secrets

```bash
cp .env.example .env.prod
chmod 600 .env.prod
```

Edit `.env.prod` and set **strong** values for everything the prod compose marks
required (it uses `${VAR:?...}` so a missing secret aborts the boot — by design):

```dotenv
# --- identity / crypto (generate with: openssl rand -hex 32) ---
DIRECTUS_KEY=...
DIRECTUS_SECRET=...
DIRECTUS_ADMIN_EMAIL=ops@example.com
DIRECTUS_ADMIN_PASSWORD=...            # NOT 123456
YIJI_JWT_SECRET=...                    # >=32 chars; signs customer widget tokens

# --- database ---
DB_USER=yiji
DB_PASSWORD=...

# --- Directus service-account tokens (openssl rand -hex 24) ---
SVC_GATEWAY_TOKEN=...
SVC_WORKERS_TOKEN=...
SVC_AI_TOKEN=...

# --- public URLs (must match the proxy hostnames in step 5) ---
DIRECTUS_PUBLIC_URL=https://api.crm.example.com
CORS_ORIGIN=https://agent.crm.example.com,https://admin.crm.example.com
VITE_DIRECTUS_URL=https://api.crm.example.com
VITE_SOCKET_URL=https://ws.crm.example.com
VITE_AI_GATEWAY_URL=https://ai.crm.example.com

# --- email (required: notifications + reports) ---
SMTP_HOST=smtp.example.com
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=Yiji Support <support@example.com>

# --- reverse proxy (step 5) ---
BASE_DOMAIN=crm.example.com
ACME_EMAIL=ops@example.com

# --- optional ---
GEMINI_API_KEY=...
```

See [PRODUCTION.md → Secrets management](./PRODUCTION.md) for storing these in a
real secret manager (Vault / AWS / k8s) instead of a file.

## 4. Boot data + Directus, then apply the schema

Bring up the backing stores and Directus first, then apply the schema (collections,
roles, and the service-account tokens from your env). The bootstrap is
**idempotent** — safe to re-run.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres redis directus

# wait for Directus to report healthy, then:
DIRECTUS_URL="$DIRECTUS_PUBLIC_URL" pnpm --filter @yiji/directus-bootstrap apply
```

## 5. Bring up the services behind TLS

The repo ships a **Caddy** reverse-proxy overlay that terminates TLS with
automatic Let's Encrypt certificates and routes each hostname to the right
service (WebSocket upgrades for the gateway are handled transparently):

```bash
docker compose \
  -f docker-compose.prod.yml \
  -f deploy/docker-compose.proxy.yml \
  --env-file .env.prod up -d
```

Caddy provisions certs on first request for `agent. / admin. / api. / ws. / ai.`
under your `BASE_DOMAIN`. The routing lives in [`deploy/Caddyfile`](../deploy/Caddyfile);
adjust hostnames there if you don't use the sub-domain scheme.

> **Prefer nginx/traefik or an external LB?** Skip the overlay and point your
> proxy at the published host ports (directus `8055`, gateway `8080`,
> ai-gateway `8081`, agent-portal `8090`, admin-portal `8092`). The only
> non-obvious rule: the gateway needs **WebSocket upgrade** on `ws.` and, when
> scaled >1, **sticky sessions** for the polling fallback (see the commented
> `lb_policy` block in the Caddyfile for the equivalent).

## 6. Verify the deploy

Run the smoke test — it execs each container's own health/ready endpoint, so it
checks real readiness (downstream deps reachable), not just "container running":

```bash
./scripts/smoke-test.sh
# all services healthy
```

Then sign in at `https://admin.crm.example.com` with your `DIRECTUS_ADMIN_*`
credentials and confirm the agent portal loads at `https://agent.crm.example.com`.

## 7. Lock down the edge

`docker-compose.prod.yml` already binds every service port to **`127.0.0.1`**
(loopback), so Directus/gateway/ai-gateway/portals are **not** reachable on the
host's public interface — only Caddy (`80/443`) is. Caddy reaches the services
over the internal compose network by name, so this needs no extra config.

Caddy also sets **HSTS** + baseline security headers (see `deploy/Caddyfile`),
and the Directus service has its **rate limiter enabled** (brute-force
protection on `/auth/login`). Remaining hardening to do per the
[PRODUCTION.md security checklist](./PRODUCTION.md): a tuned Content-Security-Policy
on the portals, and forwarding Directus auth logs to your aggregator to alert on
failed-login spikes.

If you deploy **without** the Caddy overlay, front the services with your own
LB/proxy and keep the loopback bindings (or firewall the host) so nothing serves
plaintext on a public port.

---

## Rollback

Images are tagged by commit SHA and release tag, so a rollback is just
re-deploying the previous tag — no rebuild:

```bash
# find the last-known-good tag (e.g. from your release notes or the registry)
REGISTRY=ghcr.io/<owner> IMAGE_TAG=v1.2.2 \
  docker compose -f docker-compose.prod.yml -f deploy/docker-compose.proxy.yml \
  --env-file .env.prod up -d
./scripts/smoke-test.sh
```

Notes:

- **Schema:** the bootstrap is additive/idempotent and never drops columns, so an
  app rollback does not require a DB rollback in the normal case. If a release
  shipped a destructive schema change, restore from backup instead (below).
- **Always** take a DB backup _before_ a deploy you might want to undo:
  `BACKUP_DIR=/var/backups/yiji ./scripts/backup-pg.sh`.
- Restore (DESTRUCTIVE) is `./scripts/restore-pg.sh <dump> --yes` followed by
  re-running the bootstrap. See [PRODUCTION.md → Backups & DR](./PRODUCTION.md).

## Upgrading Directus

Directus runs its own migrations on boot. To move e.g. `directus:11` → a newer
minor/major:

1. Back up Postgres: `./scripts/backup-pg.sh`.
2. Bump the image tag in `docker-compose.prod.yml` (`directus/directus:<new>`).
3. `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d directus`
   and **watch the logs** for migration output (`docker compose logs -f directus`).
4. Re-run the bootstrap (`... apply`) — idempotent; reconciles our collections
   against the upgraded core.
5. `./scripts/smoke-test.sh`.

Pin to a specific patch tag in production rather than a floating major; test the
bump on a staging copy of the DB first.

## Capacity & scaling (ballpark)

Start small and scale the part that saturates — watch the `/metrics` endpoints
(`socket_active_connections`, `bullmq_queue_jobs`, request latency).

| Signal                                  | Action                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| Sockets per gateway climbing past ~5–8k | `--scale socket-gateway=N` (enable sticky sessions in Caddy)     |
| BullMQ queue depth/backlog growing      | `--scale workers=N` (jobs distribute across instances via Redis) |
| Directus CPU-bound / slow reads         | Bigger host, tune Postgres, or move PG to a managed instance     |
| Redis memory pressure                   | Bigger Redis, or move it to a managed instance                   |

A single 2 vCPU / 4 GB host comfortably serves a typical internal support team.
Because both the gateway and workers are stateless and coordinate through Redis,
horizontal scale-out on one box covers a lot of headroom before you need a second
machine.

## Graduating to managed containers / Kubernetes

When a single host isn't enough (or policy requires it):

- **Externalize state first:** point `DB_HOST` at managed Postgres and `REDIS_URL`
  at managed Redis; delete the `postgres`/`redis` services from the compose file.
  This alone removes the riskiest single-host stateful pieces.
- The three service images are stateless and already expose `/health`, `/ready`,
  and `/metrics` — they map cleanly onto ECS/Cloud Run tasks or K8s Deployments
  with liveness/readiness probes. Use `/ready` (not `/health`) for the readiness
  probe so traffic only arrives once Redis + Directus are reachable.
- Reproduce the `${VAR:?}` env contract via your platform's secret store, and the
  Caddy routing via your platform ingress/LB (keeping WebSocket + sticky-session
  rules for the gateway).
- K8s/Helm manifests are **not** in this repo yet — generate them from the compose
  topology when you commit to that target.

## Releasing to production: the owner decides when a change is visible

Since 2026-09-16, a production deploy does **not** immediately change what
agents and customers see.

| Surface          | On a prod deploy                  |
| ---------------- | --------------------------------- |
| **Admin portal** | goes live immediately             |
| **Agent portal** | parked — waits for **Update now** |
| **Chat widget**  | parked — waits for **Update now** |

A gated deploy uploads the new hashed assets and parks the new entry point
under `pending/`, leaving the live one naming the previous bundle. The build is
on the server and unreachable until the owner presses **Update now** on the
admin dashboard. So a design change or a new feature reaches agents and
customers at a moment somebody chose, not the moment CI went green.

**The admin portal is never gated, and that is load-bearing.** The release
button lives there, so gating it would trap the button inside the build it is
meant to release — you could not press the thing that would ship the thing. We
hit exactly that on 2026-09-16.

**Staging is never gated**: it exists to be looked at immediately.

### What makes it work

| Piece        | Where                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- |
| Parked build | `s3://<bucket>/pending/…`                                                             |
| Pending list | Directus `app_settings` → `release.pending` (CI, via `POST /jobs/releases/published`) |
| Live record  | `app_settings` → `release.live`                                                       |
| The button   | admin portal dashboard, `admin_access` only; the gateway re-checks                    |
| The swap     | `POST /jobs/releases/apply` — S3 CopyObject, then a CloudFront invalidation           |

Releasing is a **file swap**: the entry points are served `no-cache` and name
content-hashed assets, so copying the parked file over the live one is the
whole release, and undoing it is another copy.

**Copy THEN invalidate, never the reverse.** An invalidation issued first
clears the cache and immediately refills it with the OLD file — success
reported, nothing changed.

### Why the routes live under `/jobs/`

The ALB sends `/webhooks/*`, `/jobs/*` and `/walk-in/*` to the socket-gateway
and **everything else to Directus**. A route at `/releases` was answered by
Directus with `Route /releases doesn't exist` — the endpoint existed, ran, and
was unreachable.

### Configuration

`RELEASE_TARGETS` is a comma-separated list of `bucket:distribution` pairs, with
an optional third part listing the files to promote (separated by `|`, default
`index.html`). Without it, `/jobs/releases/apply` answers **503 "releases are
not configured"** rather than half-releasing.

```
RELEASE_TARGETS=crm-prod-agent-portal:E3UK8T8DHFGMNW,crm-prod-widget-408568863712:E15DCMX8ZCU62R:index.html|walk-in.html|walk-in
RELEASE_REGION=us-east-2
```

The widget needs all three files because it serves `index.html`, `walk-in.html`
and an extensionless `walk-in` key for the QR poster, all naming the same hashed
assets. Release some and not others and a customer scanning a poster gets a
different build from one opening the chat link.

**Note the admin portal is absent.** Adding it would re-create the
chicken-and-egg above.

CI also uses `RELEASE_API_URL` and `SVC_GATEWAY_TOKEN` as repository secrets to
record the version number. Both are best-effort: without them the build still
parks and the banner still finds it by reading the bucket — it just cannot name
the version.

### Permissions, and the one that is missing

The gateway reaches the buckets through a **bucket policy**
(`AllowGatewayRelease`), not an IAM role policy — the same mechanism CI uses,
and the only one available, since the configured AWS user has
`IAMReadOnlyAccess`.

**`cloudfront:CreateInvalidation` is NOT granted.** A release therefore
succeeds with a warning that the CDN cache was not cleared. That is not a
failure: the entry points are `no-cache`, so the new build reaches people as
their browser revalidates — minutes, not instantly. To make it instant, somebody
with IAM write access (`r.obeid@anan.sa` holds AdministratorAccess) must add to
`crm-task-role-prod`:

```json
{
  "Sid": "ReleaseInvalidate",
  "Effect": "Allow",
  "Action": "cloudfront:CreateInvalidation",
  "Resource": [
    "arn:aws:cloudfront::408568863712:distribution/E3UK8T8DHFGMNW",
    "arn:aws:cloudfront::408568863712:distribution/E15DCMX8ZCU62R"
  ]
}
```

### Why `--delete` is gone from the gated syncs

It pruned each bucket to exactly the new build, which would delete the assets
the **live** build is still serving — the surface would go blank between deploy
and release. Old assets accumulate instead; they are content-hashed, so they
cost storage and nothing else. For the same reason the widget's prune excludes
`pending/`, or it would delete the parked pages it had just uploaded.
