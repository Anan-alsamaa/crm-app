# Taking the CRM to production

> **STATUS 2026-09-07 — the production DATABASE is temporary.** A dedicated
> RDS instance has been requested from the manager. `crm_prod` on the shared
> `test-yiji` instance is a placeholder that let the rest be built and proved;
> when the real instance arrives, only `DB_HOST`, `DB_USER`, `DB_PASSWORD` and
> `DB_DATABASE` change, in **two** task definitions (`crm-prod-directus` and
> `crm-prod-bootstrap`) — nothing else in this document depends on where the
> database lives.
>
> **Already standing and independent of that move:** the four target groups,
> the host-based ALB rules, the five task definitions, the production Directus
> service, the schema, and the nine app roles with their 563 permissions
> (`scripts/copy-roles-to-prod.mjs`, idempotent — re-run it against the new
> database).
>
> **The sequence when the instance arrives:** point the two task definitions at
> it, re-run `crm-prod-bootstrap` for the schema, re-run the role copy, load the
> stores and brands, create the three remaining services, then verify with the
> chat probe before go-live.

**Written 2026-09-07**, after reading what staging actually runs rather than
what the runbooks assume. Everything below was verified against AWS and the
live database, not inferred.

The front-ends are already deployed and serving. What does not exist is the
**entire backend**: zero ECS services in `crm-prod`, zero production target
groups, and every rule on the shared ALB pointing at `crm-stg-*`.

---

## The one thing to understand first

`crm-api.anan.sa` already resolves and answers `{"status":"ok"}` — **from the
STAGING database**. Its CloudFront distribution fronts the shared ALB, and that
ALB has no production routing at all, so the default rule catches everything and
hands it to staging.

Nothing is broken by this today, because nobody uses the name yet. It becomes a
data-integrity incident the moment somebody does, and a health check will not
warn you: it reports the health of staging, cheerfully.

**So the ALB rules are not the last step. They are the step that makes the
production name mean what it says.**

---

## What production shares with staging, and what it must not

Staging and production run on **the same RDS instance and the same Redis
cluster**. That instance also hosts other teams' production data
(`afcoOrderManangement`, `afcoLoyality`, `afcoRefData`, `HangFireJobs`).

| Resource       | Staging                  | Production                    |
| -------------- | ------------------------ | ----------------------------- |
| RDS instance   | `test-yiji…` (shared)    | the same instance             |
| Database       | `crm_staging`            | **`crm_prod`** — to create    |
| Redis          | `clustercfg.redis-yiji…` | the same cluster              |
| Uploads bucket | `crm-staging-uploads-…`  | `crm-prod-uploads-…` (exists) |
| ECS cluster    | `crm-staging`            | `crm-prod` (exists, empty)    |
| Task role      | `crm-task-role-staging`  | `crm-task-role-prod` (exists) |

Sharing the instance is a cost decision already taken. What matters is that
**the database is separate**, so a mistake in one cannot write to the other.
Redis is shared and must be key-prefixed, or a staging worker and a production
worker will consume each other's jobs.

---

## Sequence

Each step is verifiable before the next begins. Steps 1–4 are invisible to
users.

### 1. The production database (no AWS permission needed)

`CREATE DATABASE crm_prod` on the shared instance. Verified possible: the
`yijicrm` role has `rolcreatedb`. Then the bootstrap job builds the schema,
roles and permissions exactly as it did for staging.

**Not a copy of staging.** Staging holds 1,692 imported tickets, test contacts
and probe rows. Production starts empty apart from the store master and the
brands, which are reference data.

### 2. Task definitions

Register four families from `deploy/aws/ecs/*.json`, substituting the production
values. The templates carry `{{SECRET:…}}` placeholders, and **SSM and Secrets
Manager are both denied on this account** — an accepted risk recorded earlier —
so these ship as plaintext environment variables, exactly as staging does.
Anyone with ECS read access can read them, and they persist in every
task-definition revision for ever.

Every secret must be **different from staging's**. A shared JWT secret means a
staging-minted customer token authenticates against production.

### 3. Services

Four Fargate services in `crm-prod`, same CPU/memory as staging (Directus and
workers 512/1024, the two gateways 256/512), same subnets and security groups,
`assignPublicIp: DISABLED`.

Start them **before** any routing exists. A service that cannot start is a
problem to find with nothing pointed at it.

### 4. Target groups

Four new groups (`crm-prd-directus`, `crm-prd-socketio`, `crm-prd-socket`,
`crm-prd-ai`) on the same ports staging uses. Health checks must pass before
step 5, or step 5 routes traffic into nothing.

### 5. ALB routing — the step that changes behaviour

The ALB currently separates services by **path only**, which cannot express two
environments. Production rules must therefore match on **host header**
(`crm-api.anan.sa`) as well as path, and staging's existing rules need the same
treatment (`crm-api-staging.anan.sa`) or they will keep catching everything.

This is the only step that can break staging. Do it with staging's own probe
running.

### 6. Prove it, exactly as staging was proved

Run the chat round-trip probe against production: a real browser as the
customer, a real agent socket, message out and reply back, and both stored.
Staging passed 4/4 on 2026-09-07; production must pass the same before anyone is
told it is ready.

### 7. Config that is NOT in any bundle

- `PUBLIC_URL` on Directus — password-reset and invitation emails are built from
  it.
- `CORS_ORIGIN` / `WIDGET_CORS_ORIGIN` — the production portal and widget
  hostnames.
- The widget **bakes the API host in at build time**, so it must be rebuilt when
  `crm-api.anan.sa` becomes real, not merely re-synced.

---

## What is blocked, and what is not

| Need                        | Status                                                   |
| --------------------------- | -------------------------------------------------------- |
| ECS create/register/update  | allowed                                                  |
| Target groups + ALB rules   | allowed                                                  |
| CloudWatch log groups       | allowed                                                  |
| `CREATE DATABASE`           | allowed (database-level, not IAM)                        |
| **Container images in ECR** | **BLOCKED** — the deploy role cannot pull; 5 builds fail |
| SSM / Secrets Manager       | denied — plaintext env, accepted risk                    |
| RDS describe/create         | denied — irrelevant, we reuse the instance               |

**The ECR grant is the real blocker for anything new.** Production runs the same
images staging does. Steps 1–4 can proceed using the image tags already in ECR;
anything built after today waits on the grant.

---

## Order of risk

Lowest first, so that stopping at any point leaves a working system:

1. Database — invisible, reversible by `DROP DATABASE crm_prod`.
2. Task definitions — inert until a service uses them.
3. Services — running but unreachable; nothing routes to them.
4. Target groups — registered, health-checked, still unrouted.
5. **ALB rules** — the first step users could notice, and the only one that can
   affect staging.
6. Verification.

Steps 1–4 are safe to do now. Step 5 deserves a deliberate go-ahead.
