# Staging, production, and how a change reaches them

`DEPLOYMENT.md` tells you how to stand a host up. This tells you how to keep
**two** environments on it and move a change between them without ceremony.

The whole thing rests on one rule:

> **Build the artifact once. Promote that exact artifact.**
> Staging proves nothing about production if production runs a different build.

That rule is real here, not aspirational: the portal images read their URLs from
`/config.js` at container start (`resolveUrl` in `@yiji/shared-config`), so the
same image serves both environments. Nothing is baked per environment.

---

## 1. The shape, and what it costs

**One host runs both environments** as two Compose projects. The stack is small
— an internal CRM for a bounded number of agents — and a second VM would double
the bill to isolate a staging database that could just as well be a second
container.

|                  | staging                      | production                   |
| ---------------- | ---------------------------- | ---------------------------- |
| Compose project  | `crm-staging`                | `crm-prod`                   |
| Env file         | `.env.staging`               | `.env.prod`                  |
| Postgres / Redis | its own containers + volumes | its own containers + volumes |
| Hostnames        | `*-stg.crm.example.com`      | `*.crm.example.com`          |
| Image tag        | `main` (every merge)         | `v1.4.2` (a release tag)     |
| Data             | anonymised restore, or seed  | real                         |

**Sizing.** 4 vCPU / 8 GB / 80 GB SSD holds both comfortably: production is two
Postgres, two Redis, six Node containers and four nginx, and staging idles most
of the day. Start there; the stack scales **on one box** (`--scale
socket-gateway=3 --scale workers=2`) because the realtime layer coordinates
through Redis, so you will feel CPU pressure long before you need a second host.

**Never share a database between the two.** Not to save RAM, not "just for
now". A staging run that writes to production data is the one mistake this
topology can make, and separate containers make it impossible rather than
merely discouraged.

---

## 2. One-time setup

### 2a. Host

Follow `DEPLOYMENT.md` §1–§4 once. Then, for the second environment, the only
differences are the project name, the env file and the ports:

```bash
# production
docker compose --project-name crm-prod --env-file .env.prod \
  -f docker-compose.prod.yml up -d

# staging — same file, different project, different env
docker compose --project-name crm-staging --env-file .env.staging \
  -f docker-compose.prod.yml up -d
```

Compose namespaces volumes and networks by project, so `crm-staging` gets its
own `crm-staging_postgres_data` and cannot reach production's.

In `.env.staging`, shift every host port so the two do not collide:

```
DIRECTUS_PORT=9055
SOCKET_GATEWAY_PORT=9080
SOCKET_GATEWAY_HTTP_PORT=9082
AI_GATEWAY_PORT=9081
AGENT_PORTAL_PORT=9090
ADMIN_PORTAL_PORT=9092
```

### 2b. TLS and routing

Caddy in front, both environments in one Caddyfile. Ten hostnames, five per
environment: `agent`, `admin`, `api`, `ws`, `ai`.

```
agent.crm.example.com      { reverse_proxy 127.0.0.1:8090 }
agent-stg.crm.example.com  { reverse_proxy 127.0.0.1:9090 }
ws.crm.example.com         { reverse_proxy 127.0.0.1:8080 }   # WebSocket
ws-stg.crm.example.com     { reverse_proxy 127.0.0.1:9080 }
# …and so on for admin / api / ai
```

Caddy gets certificates automatically. Every container binds to `127.0.0.1`
only, so nothing is reachable except through it.

### 2c. Secrets

```bash
./scripts/gen-prod-secrets.sh          # writes strong values, once per env
```

Generate **separately for each environment**. A shared `DIRECTUS_KEY` means a
staging token is a production token.

Set `YIJI_COUPON_DELIVERY=off` in `.env.staging` **and leave it off** — staging
must never hand a real customer a real coupon. See §5.

### 2d. Schema

```bash
docker compose --project-name crm-staging --env-file .env.staging \
  -f docker-compose.prod.yml run --rm bootstrap
```

The bootstrap is idempotent and additive; `deploy-preflight` proves that by
applying it twice against a fresh database on every PR.

---

## 3. The loop, once a day or once a sprint

```
feature branch ──PR──▶ main ──▶ staging ──tag──▶ production
      │                 │          │                │
   pnpm verify        CI green   soak + smoke    same image
```

**1 — On the branch.** `pnpm verify` (nine gates) and `pnpm test:e2e`. CI runs
both on the PR; do not merge red.

**2 — Merge to `main`.** The `Deploy` workflow builds the three service images
and both portals, and pushes them to GHCR tagged with the commit SHA and
`main`.

**3 — Ship to staging.** Nothing to build:

```bash
cd /srv/crm && git pull
IMAGE_TAG=main docker compose --project-name crm-staging \
  --env-file .env.staging -f docker-compose.prod.yml pull
IMAGE_TAG=main docker compose --project-name crm-staging \
  --env-file .env.staging -f docker-compose.prod.yml up -d
docker compose --project-name crm-staging --env-file .env.staging \
  -f docker-compose.prod.yml run --rm bootstrap     # if the schema changed
```

**4 — Verify on staging** (§4).

**5 — Tag the release.** The tag is the promotion:

```bash
git tag v1.4.2 && git push origin v1.4.2
```

CI re-tags the **same digests** as `v1.4.2`. No rebuild, so nothing can differ
between what you tested and what you ship.

**6 — Ship to production.** Identical commands, `crm-prod`, `IMAGE_TAG=v1.4.2`.

**7 — Rollback** is the previous tag, and takes about forty seconds:

```bash
IMAGE_TAG=v1.4.1 docker compose --project-name crm-prod \
  --env-file .env.prod -f docker-compose.prod.yml up -d
```

Rollback covers code. It does **not** undo a schema change or a data migration
— see §6.

---

## 4. What "verified on staging" means

Not a click-around. These, every time:

- [ ] `curl -fsS https://api-stg…/server/health` and each service's `/ready` → 200
- [ ] Sign in to both portals; the masthead loads and the nav matches the role
- [ ] `pnpm test:e2e` pointed at staging — the full agent / admin / widget flow
- [ ] Open the widget, send a message, see it reach the agent inbox, reply back
- [ ] Raise a ticket, request a coupon, approve it → the card says **"Approved —
      waiting to be sent to Yiji"** (delivery is off on staging, and that is the
      correct end state there)
- [ ] Anything the release actually changed, exercised by hand
- [ ] `docker compose … logs --since 10m | grep -iE "error|fatal"` → nothing new

Then, and only then, tag.

---

## 5. Things that must differ between the environments

| Setting                | staging                                             | production                  | why                                                        |
| ---------------------- | --------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| `YIJI_COUPON_DELIVERY` | `off`                                               | `on` when the owner says so | Real money. Off, coupons stay `approved`, which is honest. |
| `YIJI_ADMIN_*`         | Yiji's test credential if they have one, else blank | the live service account    | Blank degrades honestly: `disabled`, not broken.           |
| `SMTP_*`               | a catcher (Mailpit)                                 | the real relay              | Staging must not email real customers.                     |
| `GEMINI_API_KEY`       | may be blank                                        | set                         | AI degrades to a clean `503`.                              |
| `CORS_ORIGIN`          | staging hostnames                                   | production hostnames        | The prod guard rejects `*`.                                |
| Every secret           | its own                                             | its own                     | A shared key makes the two one environment.                |

**The coupon switch deserves its own line.** It works from a _backlog_: the
sweep picks up everything approved and undelivered, so the first tick after it
goes live sends all of them at once. Turning it on is a decision, taken
deliberately, not a side effect of a deploy.

---

## 6. Schema and data changes

Code rolls back. Data does not. So:

- **The bootstrap is additive.** It adds collections, fields, permissions; it
  never drops. That is what makes it safe to run before the new code arrives.
- **Order of operations:** bootstrap first, then the new images. A new column
  the old code ignores is harmless; new code against a missing column is not.
- **One-off data repairs are scripts, dry-run by default** — `normalise-phones`,
  `repair-store-snapshots`, `backfill-store-snapshots`. Run them on staging
  first, read the report, then `--write`. Every one of them prints what it will
  do before it does it.
- **Back up before any of them:**
  ```bash
  docker compose --project-name crm-prod exec -T postgres \
    pg_dump -U "$DB_USER" "$DB_NAME" | gzip > backup-$(date +%F-%H%M).sql.gz
  ```
  `scripts/backup-pg.sh` does this nightly. Test a restore into staging once a
  quarter — a backup nobody has restored is a hypothesis.

---

## 7. After the first production cutover

- [ ] Rotate every secret away from its development value
- [ ] `NODE_ENV=production` on all three Node services (it activates the guards)
- [ ] Nightly `backup-pg.sh` on a cron, off-host retention
- [ ] Uptime check on `/server/health` and one portal
- [ ] `docker system prune -f --filter "until=168h"` weekly, or the disk fills
      with old images
- [ ] Watch `ticket_events` growth for the first fortnight — it is 95% of the
      database by row count and the one table that has surprised us before
