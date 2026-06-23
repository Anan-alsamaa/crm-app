# Production runbook

How to build, configure, stand up, observe, back up, and operate Yiji CRM in
production. If you are doing a first deploy, read top-to-bottom. If you are on
call, jump to [Operational runbook](#operational-runbook).

- [Topology](#topology)
- [Images](#images)
- [Configuration & env validation](#configuration--env-validation)
- [Secrets management](#secrets-management)
- [Standing up the stack](#standing-up-the-stack)
- [Observability](#observability)
- [CORS & security headers](#cors--security-headers)
- [Backups & disaster recovery](#backups--disaster-recovery)
- [Scaling](#scaling)
- [Deploy workflow](#deploy-workflow)
- [Security checklist](#security-checklist)
- [Operational runbook](#operational-runbook)

## Topology

Five long-lived processes plus three SPAs and the embeddable widget bundle.
Everything is stateless except Postgres and Redis.

```
                       ┌──────────────────────┐
   Customer browser ──▶│  CDN / static host   │  yiji-chat-widget.js (IIFE)
                       └──────────┬───────────┘
                                  │  /socket.io
                                  ▼
         ┌──────────────┐   ┌──────────────────┐   ┌────────────────┐
         │ Agent portal │──▶│  socket-gateway  │◀──│  Redis 7       │
         └──────────────┘   │  (Fastify + IO)  │   │  (adapter +    │
         ┌──────────────┐   │  N instances     │   │   pub/sub +    │
         │ Admin portal │──▶└────────┬─────────┘   │   BullMQ +     │
         └──────────────┘            │             │   AI cache +   │
                                     │   write     │   rate limit)  │
                                     ▼             └────────┬───────┘
                              ┌──────────────┐              │
                              │   Directus   │◀─────────────┘
                              │   (Postgres) │   read by every service
                              └────────┬─────┘
                                       │
         ┌────────────┐   pull jobs    │            ┌──────────────────┐
         │  workers   │───────────────▶│            │   ai-gateway     │
         │  N inst.   │                │◀───────────│   (Fastify)      │
         │            │   read context │   read     │   Gemini outbound│
         └────────────┘                ▼            └──────────────────┘
                              ┌──────────────┐
                              │   SMTP       │
                              │   (notif +   │
                              │    reports)  │
                              └──────────────┘
```

Only Directus directly touches Postgres. The three Node services reach Directus
over HTTP and Redis over the wire — they hold no durable state.

## Images

The three Node services ship as multi-stage images (see each
`services/*/Dockerfile`). The final layer contains **production dependencies
only** — `typescript`, `@types/*`, mocks and test tooling are pruned. TypeScript
is executed at runtime by `tsx` (a production dependency); it is deliberately
**not** bundled, so OpenTelemetry auto-instrumentation can still patch `http`,
`ioredis`, etc. Images run as the non-root `node` user under `tini` (PID 1, clean
signal forwarding for graceful shutdown) and declare a `HEALTHCHECK`.

Build locally (from the repo root):

```bash
docker compose -f docker-compose.prod.yml build
# or a single service:
docker build -f services/ai-gateway/Dockerfile -t yiji/ai-gateway .
```

Build + push to GHCR via CI: the [`Deploy`](#deploy-workflow) workflow.

| Service          | Image base       | Runtime port | Health port | Healthcheck          |
| ---------------- | ---------------- | ------------ | ----------- | -------------------- |
| `directus`       | `directus:11`    | 8055         | 8055        | `GET /server/health` |
| `socket-gateway` | `node:20-alpine` | 8080         | 8081        | `GET :8081/health`   |
| `ai-gateway`     | `node:20-alpine` | 8081         | 8081        | `GET :8081/health`   |
| `workers`        | `node:20-alpine` | —            | 8090        | `GET :8090/health`   |
| portals/widget   | static (CDN)     | 80/443       | n/a         | n/a                  |
| `agent-portal`\* | `nginx:alpine`   | 80           | 80          | `GET /health`        |
| `admin-portal`\* | `nginx:alpine`   | 80           | 80          | `GET /health`        |

\* The portals are **static SPAs**; the default and recommended hosting is a
CDN / static host (cheapest, fastest, no servers to run). For a self-contained
single-host deploy you can instead build the container images
(`apps/{agent,admin}-portal/Dockerfile`, wired into `docker-compose.prod.yml` as
the `agent-portal` / `admin-portal` services, default host ports 8090 / 8092).
`VITE_*` values are baked at **build** time (client-visible) — pass the real
public URLs as `--build-arg` and never bake secrets.

## Configuration & env validation

Every service validates its environment with Zod at boot (`services/*/src/config.ts`)
and **fails fast** with an aggregated error if anything is missing or invalid —
a misconfigured deploy crashes immediately instead of degrading silently.

Set `NODE_ENV=production` on the three Node services. That flips on production
guards that reject footguns which are tolerated in dev:

| Guard                                              | Service(s)                 |
| -------------------------------------------------- | -------------------------- |
| `CORS_ORIGIN` must not be `*`                      | socket-gateway, ai-gateway |
| Secrets/tokens must not be `replace-with-*`        | all three                  |
| `YIJI_JWT_SECRET` must be ≥ 32 chars               | socket-gateway             |
| `REDIS_ENABLED` must be `true` (no in-memory)      | socket-gateway             |
| `SMTP_HOST` must be set (else notifications no-op) | workers                    |

`GEMINI_API_KEY` is intentionally **not** required — the ai-gateway degrades
gracefully (AI endpoints return `503 not_configured`) and logs a loud warning at
boot, so the degrade is visible rather than silent.

### Required environment overrides

Every value below MUST differ from the `.env.example` defaults. Generate secrets
with `openssl rand -hex 32`.

| Variable                  | Why it matters                                                         |
| ------------------------- | ---------------------------------------------------------------------- |
| `DIRECTUS_ADMIN_PASSWORD` | Owner admin password (dev value is `123456` — never ship it)           |
| `DIRECTUS_KEY`            | Directus internal signing key                                          |
| `DIRECTUS_SECRET`         | Directus internal secret                                               |
| `YIJI_JWT_SECRET`         | Customer widget JWT signing secret (HS256) — rotate with the host page |
| `SVC_GATEWAY_TOKEN`       | socket-gateway → Directus service-account token                        |
| `SVC_WORKERS_TOKEN`       | workers → Directus service-account token                               |
| `SVC_AI_TOKEN`            | ai-gateway → Directus token + the token clients present to the gateway |
| `CORS_ORIGIN`             | Exact portal hostnames on every Node service — no `*` in prod          |
| `REDIS_URL`               | Real Redis 7+ (managed or self-hosted), TLS-terminated                 |
| `DB_USER` / `DB_PASSWORD` | Distinct Postgres service user (not `directus`/`directus`)             |
| `SMTP_*`                  | Real SMTP relay for notifications + scheduled reports                  |

Optional but recommended: `GEMINI_API_KEY`; `OTEL_EXPORTER_OTLP_ENDPOINT`
(see [Observability](#observability)); `YIJI_API_URL` with `YIJI_API_KEY`
(switches YijiClient from mock to HTTP commerce lookups); `STORAGE_DRIVER=s3`
with `STORAGE_S3_*` (off-host Directus uploads + CSV imports).

## Secrets management

**The repo never holds real secrets.** It holds `.env.example` placeholders and
this documentation only. Every secret is injected at runtime as an environment
variable; because all services read config from `process.env` via Zod, **no code
change is needed to switch secret stores** — only the injection mechanism differs.

Pick the store that matches your platform:

| Platform                   | Store                                                                                                            | Injection mechanism                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Kubernetes                 | **k8s Secrets** (+ optional [External Secrets Operator](https://external-secrets.io) syncing from a cloud store) | `envFrom: [{ secretRef: { name: yiji-secrets } }]` on each Deployment           |
| AWS (ECS/EKS)              | **AWS Secrets Manager**                                                                                          | ECS `secrets:` valueFrom ARN, or EKS via External Secrets Operator              |
| HashiCorp                  | **Vault**                                                                                                        | Vault Agent sidecar / `vault agent` template rendering an env file              |
| Single VM (docker compose) | **`.env.prod` file**, `chmod 600`, outside the repo                                                              | `docker compose --env-file .env.prod` (the prod compose reads `${VAR}` from it) |

Rules:

- Generate strong values: `openssl rand -hex 32` for keys/secrets; Directus
  service tokens are minted by bootstrap from the `SVC_*` env you supply.
- The prod compose uses `${VAR:?message}` for required secrets, so a missing
  secret aborts `up` with a clear message — never a silent empty default.
- **Rotation**: `YIJI_JWT_SECRET` must rotate in lockstep with the widget host
  page (both sign/verify HS256). `SVC_*` tokens rotate by updating the env and
  re-running bootstrap (`apply` updates each service user's token in place).
  `DIRECTUS_KEY`/`SECRET` rotation invalidates existing Directus sessions.
- Restrict read access to the secret store to the deploy identity only. Never
  bake secrets into images or compose files; never commit `.env.prod`.

## Standing up the stack

### Deploy on a fresh server (Docker-only)

The model: the server has **Docker** and a copy of the **repo** — nothing else.
The base components (Postgres, Redis, Directus) are **pulled** as public images;
the custom parts (gateway, workers, ai-gateway, portals, bootstrap) are **built
from source on the server**. Nothing is hand-shipped — no `docker save`/`load`,
no registry required.

Prerequisites on the box: Docker Engine + the Compose plugin
(`docker --version && docker compose version`), and the repo present
(`git clone …`). That's it — no host Node/pnpm.

```bash
cd <repo>
cp .env.prod.example .env.prod      # then edit: real secrets (see "Required env")
chmod 600 .env.prod

# Build the custom images from source, pull the public ones, seed Directus, run.
docker compose -f docker-compose.prod.yml --env-file .env.prod build
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres redis directus
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm bootstrap
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# Verify
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

Notes / gotchas:

- **Always `build` (or use `--build`) before `up`.** The custom services also list
  a registry `image:` tag for the optional CI path; if you `up` without having
  built and the image isn't local, Docker tries to _pull_ `ghcr.io/...` and fails.
  Building first makes that tag a purely local name.
- **Portal URLs bake at build time.** `VITE_DIRECTUS_URL` / `VITE_SOCKET_URL` /
  `VITE_AI_GATEWAY_URL` are read as build args into the static SPA bundles —
  set the real public URLs in `.env.prod` _before_ `build`; rebuild if they change.
- **TLS / domain:** the compose exposes raw HTTP ports. For a public domain put a
  reverse proxy (Caddy/nginx) in front for HTTPS, and use sticky sessions if you
  scale `socket-gateway` (see [CORS & security](#cors--security-headers) and
  [Scaling](#scaling)).
- **Managed DB/Redis:** delete the `postgres`/`redis` services and point
  `DB_HOST` / `REDIS_URL` at the managed endpoints.

### Single host (docker compose)

`docker-compose.prod.yml` is additive — `docker-compose.yml` stays the working
local-dev stack. The prod file runs the services with `NODE_ENV=production`,
strict secrets, and image refs (with a build fallback).

```bash
# 1. Put real secrets in .env.prod (chmod 600, never committed).
# 2. Build images FROM SOURCE on this host (no registry, nothing to ship).
docker compose -f docker-compose.prod.yml --env-file .env.prod build
# 3. Boot infra + Directus (postgres/redis/directus are pulled public images).
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres redis directus
# 4. Bootstrap schema, roles, service tokens, and project owner (idempotent).
#    Runs as a one-shot container, so the host needs only Docker — no Node/pnpm.
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm bootstrap
# 5. Boot the services.
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

> The `bootstrap` service carries a `bootstrap` profile, so `up` never starts it;
> it only runs when you invoke it explicitly with `run --rm` (step 4). Re-run that
> one command any time to reconcile schema after a restore or to rotate `SVC_*`
> tokens. If you prefer to run it from a Node toolchain on the host instead of the
> container, the equivalent is `pnpm --filter @yiji/directus-bootstrap apply`.

In a managed environment, delete the `postgres`/`redis` services from the prod
compose and point `DB_HOST` / `REDIS_URL` at the managed endpoints.

### Bootstrap idempotence

`apply` is safe to re-run — every step tolerates "already exists". This is
enforced in CI by `deploy-preflight.yml`, which runs `apply` twice against a
fresh Postgres and asserts the second run creates nothing
(`pnpm --filter @yiji/directus-bootstrap check-idempotence`). Run it locally the
same way against a throwaway DB.

## Observability

### Health vs readiness

- `GET /health` — liveness. Process is up. Use for container `HEALTHCHECK` and
  k8s `livenessProbe`.
- `GET /ready` — readiness with **real downstream checks**. Returns `503` with a
  per-dependency `checks` object when a dependency is down:
  - socket-gateway: Redis `PING` (when enabled) + Directus `/server/health`.
  - ai-gateway: Redis `PING` + Directus `/server/health`.
  - workers: Redis `PING`.
    Wire `/ready` to k8s `readinessProbe` / LB target health so unready instances
    are pulled from rotation.

### Metrics (Prometheus)

Each service exposes `GET /metrics` in Prometheus text format (a small zero-dep
exporter — no `prom-client`). Default process metrics (RSS, heap, uptime) plus:

| Service        | Key series                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------- |
| socket-gateway | `socket_active_connections`, `socket_connections_total`                                     |
| ai-gateway     | `http_requests_total{method,route,status}`, `http_request_duration_seconds`                 |
| workers        | `bullmq_queue_jobs{queue,state}`, `bullmq_jobs_completed_total`, `bullmq_jobs_failed_total` |

Scrape ports: socket-gateway `:8081`, ai-gateway `:8081`, workers `:8090`.

```yaml
scrape_configs:
  - job_name: yiji
    metrics_path: /metrics
    static_configs:
      - targets: ['socket-gateway:8081', 'ai-gateway:8081', 'workers:8090']
```

### Tracing (OpenTelemetry)

All three services bootstrap the OTel Node SDK (`services/*/src/telemetry.ts`),
imported first so auto-instrumentation patches `http`, `ioredis`, `pg`, etc.
It is **entirely no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set**, so local
and test runs never need a collector. Configuration is the standard OTel env set:

| Variable                      | Example                              |
| ----------------------------- | ------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4318`         |
| `OTEL_EXPORTER_OTLP_HEADERS`  | `authorization=Bearer <token>`       |
| `OTEL_SERVICE_NAME`           | `socket-gateway` (defaulted per svc) |

Because the services run as ESM via `tsx`, full auto-instrumentation needs the
loader hook. The prod compose sets it by default:

```
NODE_OPTIONS=--import @opentelemetry/instrumentation/hook.mjs
```

The SDK still starts cleanly without the hook (reduced span coverage). Point the
OTLP endpoint at any collector (Grafana Alloy, OTel Collector, vendor agent).

### Logs

Every Node service emits structured JSON via pino. Pipe stdout to your log
aggregator. Set `LOG_LEVEL` (`info` default; `debug` for triage).

## CORS & security headers

- **CORS**: `CORS_ORIGIN` is a comma-separated exact-match allow-list on every
  Node service. The production env guard rejects `*`. Set it to the portal
  hostnames, e.g. `https://agent.example.com,https://admin.example.com`. Directus
  has its own `CORS_ORIGIN` (set in the prod compose).
- **Service response headers**: each Fastify app sets `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`, and strips `X-Powered-By`.
- **CSP belongs on the portals/widget**, not the JSON APIs. Set
  `Content-Security-Policy` (and HSTS) at the static-hosting / CDN layer that
  serves `apps/agent-portal`, `apps/admin-portal`, and the widget bundle. The
  policy must allow the portal's own origin plus the socket-gateway WSS origin
  and the ai-gateway origin (`connect-src`).
- **TLS** terminates at the LB/proxy in front of every HTTP service; WebSockets
  terminate over WSS with sticky sessions (see [Scaling](#scaling)).

## Backups & disaster recovery

Postgres is the only system of record. Scripts live in `scripts/`:

```bash
# Nightly compressed backup (pg_dump -Fc) with 7-day retention.
BACKUP_DIR=/var/backups/yiji RETENTION_DAYS=7 ./scripts/backup-pg.sh

# Restore (DESTRUCTIVE — drops + recreates objects, requires --yes):
./scripts/restore-pg.sh /var/backups/yiji/yiji-yiji_crm-<stamp>.dump --yes
pnpm --filter @yiji/directus-bootstrap apply   # reconcile schema after restore
```

Both resolve the connection from `$DATABASE_URL` or the `DB_*` env, and document
a `docker compose exec postgres` variant inline for when no local `psql` client
is present. Schedule the backup via cron / a k8s CronJob.

| Asset            | Strategy                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Postgres         | Nightly `backup-pg.sh` + continuous WAL archiving for PITR. **Test restore quarterly.**                                 |
| Directus uploads | S3 lifecycle (when `STORAGE_DRIVER=s3`) or FS snapshot of the `directus_uploads` volume.                                |
| Redis            | Ephemeral by design. Lost queue data: the SLA reconcile sweep re-creates timers within 60s; other jobs are best-effort. |
| Schema drift     | `directus/bootstrap/` is canonical; keep `directus/snapshot/` in sync via `directus schema export`.                     |

## Scaling

| Component        | Strategy                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `socket-gateway` | Horizontal. L4/L7 LB with **sticky sessions** (long-polling fallback needs them). Redis adapter handles cross-instance pub/sub. |
| `workers`        | Horizontal. BullMQ distributes jobs by queue across instances. No coordination beyond Redis.                                    |
| `ai-gateway`     | Horizontal. Stateless. Rate-limit + cache are Redis-backed.                                                                     |
| Postgres         | Vertical; read replicas optional for reporting under heavy write volume.                                                        |
| Redis            | Single instance until throughput justifies a Redis Cluster.                                                                     |

```bash
docker compose -f docker-compose.prod.yml up -d --scale socket-gateway=3 --scale workers=2
```

## Deploy workflow

`.github/workflows/deploy.yml` builds the three service images and pushes them to
GHCR (`ghcr.io/<owner>/<service>`). Triggers: manual `workflow_dispatch` (ship any
branch, optional extra tag) and pushing a release tag `v*` (versioned + `latest`).
Images are tagged with the long SHA, branch, and semver. Roll out:

```bash
REGISTRY=ghcr.io/<owner> IMAGE_TAG=sha-<sha> \
  docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

`.github/workflows/deploy-preflight.yml` gates infra PRs: it validates both
compose files and verifies bootstrap idempotence on a fresh DB.

## Security checklist

- [ ] `NODE_ENV=production` on all three Node services (activates env guards).
- [ ] Every secret in `.env.example` overridden; none are `replace-with-*`.
- [ ] `DIRECTUS_ADMIN_PASSWORD` is not `123456`; `DB_USER`/`DB_PASSWORD` not `directus`.
- [ ] `CORS_ORIGIN` is an exact-match allow-list, not `*`.
- [ ] `YIJI_JWT_SECRET` ≥ 32 chars and rotated with the widget host page.
- [ ] TLS in front of every HTTP service; WebSockets over WSS (sticky-session LB).
- [ ] CSP + HSTS set at the portal/widget static-hosting layer.
- [ ] Redis on a private network / TLS-only, password-protected.
- [ ] Postgres on a private network, distinct service user.
- [ ] File storage uses signed-URL access for uploads.
- [ ] PII redaction enabled on the AI gateway (default in shipped code).
- [ ] `YIJI_WEBHOOK_SECRET` set if inbound webhooks are used (HMAC-SHA256 +
      timestamp replay window verified at `POST /webhooks/yiji`; empty = 503).
- [ ] Attachment policy tuned: `ATTACHMENT_MAX_BYTES` + `ATTACHMENT_ALLOWED_MIME`
      (enforced on `message:send` against Directus file metadata).
- [ ] Monthly AI cap + per-user/global rate limits tuned to budget.
- [ ] Append-only `ticket_events` permission intact (no UPDATE/DELETE for Agent/Admin).
- [ ] Secrets injected from a secret store, never baked into images/compose.

## Operational runbook

| Symptom                                   | Likely cause                                             | Fix                                                              |
| ----------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| Service won't start, aggregated env error | A required env var is missing/invalid                    | Read the boot error; it lists every offending var by name        |
| `/ready` returns 503                      | A downstream is unreachable                              | Inspect the `checks` object — `redis`/`directus` shows which     |
| Widget shows "connecting / reconnecting"  | socket-gateway down or Redis unreachable                 | Check `/ready` on each gateway instance                          |
| Agent inbox not refreshing in realtime    | One gateway instance can't reach Redis                   | Restart instance; verify Redis VPC reachability                  |
| AI endpoints return `not_configured`      | `GEMINI_API_KEY` empty                                   | Set the env var on ai-gateway                                    |
| AI endpoints return `monthly_cap_reached` | Vendor hit its monthly budget                            | Bump cap in Admin → AI assistance                                |
| Notifications not delivered               | `SMTP_*` empty or transport unreachable                  | workers refuses to boot in prod without `SMTP_HOST`; check creds |
| SLA warnings/breaches missed              | workers process not running                              | Check workers `/health`; restart; watch `bullmq_jobs_*` metrics  |
| Queue backlog growing                     | workers under-scaled or a processor wedged               | Watch `bullmq_queue_jobs{state="waiting"}`; scale workers        |
| Scheduled report not emailed              | `schedule.email` recipients absent or SMTP misconfigured | Verify report row + workers SMTP env                             |
| No traces in collector                    | `OTEL_EXPORTER_OTLP_ENDPOINT` unset or hook missing      | Set the endpoint + `NODE_OPTIONS` loader hook                    |
