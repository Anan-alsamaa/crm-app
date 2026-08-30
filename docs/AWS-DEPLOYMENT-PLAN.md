# AWS deployment — staging + production, MVP through enterprise

_Written 2026-08-30, against the repo as it stands. Answers four questions the
owner asked: what to run on AWS, whether to own the Postgres admin, how staging
and production stay identical without doubling the bill, and what SMTP is for._

---

## 1. What SMTP is, and why the app needs it

SMTP is the protocol for **sending** email. The CRM never receives email — it
sends, in four places, and three of them are features you already have:

| what                           | where                                          | without SMTP                                                                                                                         |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Directus password reset**    | Directus itself                                | Nobody can reset a forgotten password. You reset it by hand in the admin console, for every user, for ever.                          |
| **Notification email channel** | `services/workers/processors/notifications.ts` | Each user picks `in_app`, `email`, `both` or `none`. The in-app bell still works; the email half silently no-ops.                    |
| **Scheduled reports**          | `services/workers/processors/reports.ts`       | A scheduled report is _generated and emailed_. With no SMTP it generates and goes nowhere — the feature exists but delivers nothing. |
| **Import results**             | `services/workers/processors/imports.ts`       | The "your import finished" mail.                                                                                                     |

The workers **refuse to boot** in production without `SMTP_HOST` — a deliberate
guard, because a silently mail-less deployment looks fine until somebody needs a
password reset at 2am.

**On AWS the answer is Amazon SES.** It is the cheapest option by a wide margin
(~$0.10 per 1,000 emails; this app sends hundreds a month, so call it free), it
lives in the same account, and it hands you SMTP credentials that drop straight
into `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD`.

> ⚠ SES starts in **sandbox mode**: it will only send to addresses you have
> verified. Request production access early — approval takes a day or two and
> it is the sort of thing that blocks a cutover on the morning.

---

## 2. What to run it on

You already have AWS history here: account `408568863712`, `us-east-2`, an RDS
Postgres and an ElastiCache Redis (see `docs/DEPLOY-DIRECTUS-AWS-ECS.md`, which
records a real ECS Fargate deployment on 2026-08-06).

**Recommendation: one EC2 instance per environment, running the existing
`docker-compose.prod.yml`.** Not ECS, not Kubernetes — and the reasoning matters
because the instinct on AWS is to reach for the managed thing.

**Why not ECS/Fargate — three concrete things in THIS app, not a general
argument.**

1. **Five custom Directus extensions**, bind-mounted from the repo:
   `app-roles-sync`, `cast-custom-field-value`, `lock-project-owner`,
   `notify-on-change` (the high-value coupon alert) and
   `super-header-interface`. These are our code, and Fargate has no bind
   mounts. You would bake a custom Directus image on every extension change, or
   mount EFS. Both work; both are build and infrastructure you then maintain
   for ever.

2. **Directus uploads are a persistent volume.** Fargate containers are
   ephemeral, so this becomes EFS (cost + mount config) or S3 (a config
   change). Not hard — another moving part.

3. **The bootstrap is a one-shot container** that provisions the schema and
   must finish _before_ the rest accept traffic. On Compose that is
   `depends_on`. On ECS it is a separate `RunTask` you invoke, poll and wire
   into every deploy.

None of these is a blocker. Together they are roughly a day per environment plus
permanent maintenance, bought to solve a scaling problem this app does not have —
an internal CRM with a bounded number of agents. Fargate also costs more than
EC2 for a workload that runs 24/7.

**ECS becomes right when:** one box genuinely cannot hold the load, org policy
mandates it, or a team already runs ECS and would rather have one way of doing
things. All three are real reasons. None is true today.

**Why one box is enough.** The realtime layer coordinates through Redis, so you
can scale _within_ the box (`--scale socket-gateway=3 --scale workers=2`) long
before you need an orchestrator. A `t3.medium` (2 vCPU / 4 GB) runs the whole
stack.

**When to revisit:** genuinely outgrowing one instance, or org policy mandating
ECS. Both are real reasons; neither is true today. The services already expose
`/health`, `/ready` and `/metrics`, so they lift onto ECS later without a
rewrite — this decision is reversible.

### Shape

```
┌─ AWS account, us-east-2 ─────────────────────────────────────┐
│                                                              │
│  EC2  crm-staging   (t3.small,  ~$15/mo)                     │
│  EC2  crm-prod      (t3.medium, ~$30/mo)                     │
│         └── docker compose -f docker-compose.prod.yml         │
│               directus · socket-gateway · workers            │
│               ai-gateway · agent-portal · admin-portal       │
│                                                              │
│  RDS Postgres          ~$15/mo   two DATABASES on one        │
│                                  instance, not two instances │
│  ElastiCache Redis     ~$12/mo   two DATABASES (db 0 / db 1) │
│  SES                   ~$0       email                       │
│  ECR or GHCR           ~$0       images                      │
│                                                              │
│  Rough total: ~$75/month for BOTH environments               │
└──────────────────────────────────────────────────────────────┘
```

### Keeping the cost down without breaking the "staging must behave like prod" rule

The owner's constraint is exact: _anything that might break in prod must break in
staging_. That is about **software behaviour**, not hardware size. So:

**Share the infrastructure, isolate the data.**

- **One RDS instance, two databases** (`crm_prod`, `crm_staging`). Same engine,
  same version, same extensions, same TLS requirement — so a migration that
  fails on prod fails on staging first. Separate DB users, each granted only its
  own database, so staging cannot read production data.
- **One ElastiCache instance, two logical databases** (`redis://…/0` for prod,
  `/1` for staging). Same version, same eviction policy. Queue names are
  identical, which is exactly what you want when a BullMQ change is what broke.
- **Identical images.** Staging runs the same image digest that production will
  run — see §4. This is the single most important line in this document.
- **Identical config keys, different values.** Both environments read the same
  `.env.prod.example` shape. A var that exists in one and not the other is how
  "worked in staging" happens.

**Where they may differ, deliberately:**

|                        | staging                              | production                         |
| ---------------------- | ------------------------------------ | ---------------------------------- |
| instance size          | `t3.small`                           | `t3.medium`                        |
| `YIJI_COUPON_DELIVERY` | **`off`, permanently**               | `on` when ready                    |
| Yiji tenant            | the real one (read-only in practice) | the real one                       |
| backups                | none needed                          | nightly `backup-pg.sh` + retention |

> **`YIJI_COUPON_DELIVERY=off` on staging is not a behaviour difference to
> apologise for — it is the one that must differ.** Staging shares the real Yiji
> tenant, so `on` there hands real customers real money for test data. The code
> path is otherwise identical: coupons are created, approved, queued and picked
> up by the sweep; only the final push is suppressed, and it logs `disabled` so
> you can see it happened.

---

## 3. Owning the Postgres admin

The owner's concern: the current Postgres was provided by a manager, and they
want full control.

**This is straightforward and worth doing before go-live, not after.** Create
your own RDS instance in your own account:

1. **RDS → Create database → PostgreSQL 16**, `db.t4g.micro` to start.
2. **You set the master credentials** — that is the control you are asking for.
3. Private subnet, security group allowing 5432 **only** from the EC2 instances.
4. `Encryption: enabled`, `Automated backups: 7 days`, `Deletion protection: on`.
5. Create two databases and two users:

```sql
CREATE DATABASE crm_prod;
CREATE DATABASE crm_staging;
CREATE USER crm_prod_app    WITH PASSWORD '<generated>';
CREATE USER crm_staging_app WITH PASSWORD '<generated>';
GRANT ALL PRIVILEGES ON DATABASE crm_prod    TO crm_prod_app;
GRANT ALL PRIVILEGES ON DATABASE crm_staging TO crm_staging_app;
```

**Two traps, both already learned the hard way here:**

- **Lowercase identifiers.** `docs/DEPLOY-DIRECTUS-AWS-ECS.md` records a
  deployment that failed because the DB user was created with capitals. Postgres
  folds unquoted identifiers to lowercase; the connection string does not. Use
  lowercase throughout.
- **Migrating off the manager's instance** is `pg_dump | psql`, and it is
  genuinely easy — but do it _before_ production carries real data, when a
  mistake costs nothing. `scripts/backup-pg.sh` already does the dump half.

---

## 4. The development cycle — and zero-downtime

The owner's shape: _pull latest → add a feature → test → staging → rigorous
testing → production_, with production isolated and zero downtime.

### Repos: keep ONE

The owner asked about three repos (source of truth, staging, production).
**Recommend against it**, and the reason is concrete: three repos means three
copies of the code that can drift, and "it worked in staging" becomes
unfalsifiable because staging's repo genuinely _is_ different. Every serious
pipeline solved this the same way — **one repo, many environments, promotion by
IMAGE TAG.**

`github.com/Anan-alsamaa/crm-app` stays the single source of truth.

### The flow

```
  feature branch ──PR──▶ main ──────▶ CI builds images
                          │            tagged with the commit SHA
                          │
                          ▼
                    STAGING deploys that SHA automatically
                          │
                    (rigorous testing happens here)
                          │
                          ▼
                    git tag v1.4.0 ──▶ PRODUCTION deploys the SAME digest
```

**The critical property: production runs the exact bytes staging ran.** Not
"the same commit rebuilt" — the same image. `docker-compose.prod.yml` already
parameterises this (`IMAGE_TAG`), and `deploy.yml` already tags every build with
`type=sha,format=long`. The mechanism exists; it needs wiring, not building.

Promotion is then one line on the prod host:

```bash
IMAGE_TAG=sha-<the digest staging proved>  docker compose -f docker-compose.prod.yml up -d
```

### Zero downtime

Achievable on a single host, with three things:

1. **Rolling replace, not restart.** `docker compose up -d` recreates changed
   services only; unchanged ones keep serving. Health checks already exist on
   every service, so add `--wait` and Compose blocks until the new container is
   healthy before moving on.
2. **Two replicas of anything user-facing** during the swap — the socket gateway
   especially, since a dropped WebSocket is the most visible failure. Redis
   coordination means a second replica is safe.
3. **Migrations must be backwards-compatible.** This is the part that actually
   causes downtime, and it is a discipline rather than a tool: during a rolling
   deploy the old and new code run _simultaneously_, so a migration that removes
   a column breaks the old container still serving traffic. Add columns, deploy,
   then remove in a later release. Every migration written for this app so far
   is additive and idempotent — keep it that way.

> **What genuinely cannot be zero-downtime:** a Directus schema change that
> rewrites a large table, and a Postgres major-version upgrade. Both are rare and
> both are planned-window work. Say so out loud rather than promising otherwise.

---

## 5. Order of work

1. **SES**: verify the domain, request production access (starts the clock on
   approval).
2. **RDS**: your own instance, two databases, lowercase users.
3. **ElastiCache**: one instance, db 0 / db 1.
4. **EC2 staging**: Docker, clone, `.env.prod` from
   `.env.prod.example`, `docker compose up -d`.
5. **Bootstrap + migrations** on staging (`docs/GO-LIVE-READINESS.md` §4 lists
   all of them, including the four coupon ones).
6. **Test staging properly**, with `YIJI_COUPON_DELIVERY=off`.
7. **EC2 production**: identical, different values.
8. **Cut over**, `YIJI_COUPON_DELIVERY=on` only when you are ready to send.
9. **Wire the pipeline**: staging auto-deploys `main`, production deploys tags.

Steps 1–3 are the ones with external latency (SES approval, RDS provisioning),
so start them first even if the rest waits.
