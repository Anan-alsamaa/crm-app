# AWS resources — what exists

_Account `408568863712`, region **us-east-2 (Ohio)**. Built 2026-09-02.
Update this file whenever a resource is created or destroyed._

---

## Network — `vpc-08ea7d710f4596303` (shared EKS VPC)

The CRM's tasks must live in this VPC: ElastiCache `redis-yiji` is **private**
at `192.168.120.118` and reachable only from inside it.

| Resource                       | ID                         | Note                                                                                        |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- |
| Subnet `crm-private-2c`        | `subnet-0413e537a84480b74` | `192.168.208.0/20`, us-east-2c                                                              |
| Subnet `crm-private-2b`        | `subnet-0a6a3341b8796580a` | `192.168.224.0/20`, us-east-2b                                                              |
| Route table `crm-private-rt`   | `rtb-05bdf1062b953f9f1`    | both subnets; **no `0.0.0.0/0` yet**                                                        |
| S3 gateway endpoint            | `vpce-01fa983311f4e0c60`   | free; keeps S3 traffic off NAT                                                              |
| **NAT gateway `crm-nat`**      | `nat-021f75c7e2b27ac5d`    | in `subnet-0f7abea49c8f4a19d` (PUBLIC 2c), EIP `eipalloc-0a1ecdf0fa24d8daf`. **~$32.85/mo** |
| Security group `crm-ecs-tasks` | `sg-06ca4c19fa44b2dc3`     | outbound only; no inbound until the ALB exists                                              |

> **Tasks carry TWO security groups.** `sg-06ca4c19fa44b2dc3` is ours, and
> `sg-0cd4698b2c26e93c0` (the VPC default) is attached as a second: ElastiCache
> grants access by **membership** of that group — its rule allows all traffic
> from itself — so a task must BE a member to reach Redis. Attaching it is how
> you get Redis access **without editing a group shared with production Redis
> and MSK brokers**. Never add a rule to it.
>
> **The NAT is ours, not Yiji's.** Yiji's `nat-040304d6153bc6cf1` is
> CloudFormation-managed and serves the EKS cluster; the owner chose not to
> share it, so an outage on their side cannot break the CRM's outbound calls to
> the Yiji API, SMTP or Gemini. One NAT serves BOTH environments (staging and
> production), split 50/50 in the cost model.

Everything above is **additive** — no pre-existing resource was modified, and
the route table applies only to the two new subnets, so EKS is untouched.

> ### The two traps in this VPC
>
> **1. `SubnetPrivateUSEAST2A` (`subnet-03a19964d82d59f4c`) is NOT private.**
> Its default route is the internet gateway, not a NAT, and every subnet here
> carries `MapPublicIpOnLaunch: True`. A task placed there gets a public IP and
> sits directly on the internet — silently. **Verify a subnet by its route
> table, never by its Name tag.**
>
> **2. `nat-040304d6153bc6cf1` belongs to Yiji.** It is CloudFormation-managed
> (`eksctl-afco-cluster`) and serves the EKS cluster. Measured 2026-09-02: peak
> 49 concurrent connections against a 55,000 limit, zero `ErrorPortAllocation`
> in 7 days — so capacity was never the issue. **The owner nonetheless chose NOT
> to share it**, because Yiji's infrastructure is considered unreliable and a
> NAT failure would break the CRM's outbound calls to the Yiji API, SMTP and
> Gemini. The CRM gets its own NAT when one is created.

**There is no egress yet.** `crm-private-rt` has no default route, so a task in
these subnets cannot reach SMTP, the Yiji API, Gemini, ECR or CloudWatch. The
NAT gateway (~$32.85/mo) was deliberately deferred and must exist before any
service can run.

---

## Storage — S3

| Bucket                             | Purpose                          | Public?            |
| ---------------------------------- | -------------------------------- | ------------------ |
| `crm-staging-uploads-408568863712` | Directus attachments, staging    | no — fully blocked |
| `crm-prod-uploads-408568863712`    | Directus attachments, production | no — fully blocked |
| `crm-staging-agent-portal`         | agent SPA, staging               | CloudFront only    |
| `crm-staging-admin-portal`         | admin SPA, staging               | CloudFront only    |
| `crm-prod-agent-portal`            | agent SPA, production            | CloudFront only    |
| `crm-prod-admin-portal`            | admin SPA, production            | CloudFront only    |

All six: public access blocked, AES256 encryption. The two upload buckets also
have **versioning** enabled, so a deleted or overwritten attachment stays
recoverable.

> **The `-408568863712` suffix is not decoration.** `crm-staging-uploads` and
> `crm-prod-uploads` are already taken by other AWS customers — S3 bucket names
> are globally unique across every account. `deploy/aws/ecs/directus.json` is the
> only place the name appears and it is already updated.

---

## CDN — CloudFront

Origin Access Control `ES4AZAK3K2AK1` lets each distribution read its own
bucket while the bucket stays private. Each bucket policy names exactly one
distribution.

| Distribution  | ID               | Default domain                  |
| ------------- | ---------------- | ------------------------------- |
| staging agent | `E24IIVRFOW7GH4` | `d57v6u4ytjrj7.cloudfront.net`  |
| staging admin | `E1VN06BCLZ6Q4F` | `d1evkiaehtmzr0.cloudfront.net` |
| prod agent    | `E3UK8T8DHFGMNW` | `d1feea9xuruu0v.cloudfront.net` |
| prod admin    | `E37XKA7D2IPZLC` | `d3sw1ca3dpsao0.cloudfront.net` |

Each serves `index.html` as the root object, redirects HTTP to HTTPS, compresses
responses, and maps **403/404 to `/index.html` with a 200** — without that, a
deep link like `/tickets/42` returns S3's 404 instead of letting the SPA router
handle it.

---

## Not built, and why

| Item                        | Status                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NAT gateway**             | Deferred by the owner — ~$32.85/mo, starts billing immediately. **Required before any task runs.**                                                                                                                   |
| **ACM certificate**         | Blocked: `anan.sa` is **not** in this account's Route 53 (only `wee-learn.com` and `yiji-app.com` are), so DNS validation cannot be completed here. Distributions run on their `*.cloudfront.net` domains meanwhile. |
| **ALB**                     | Not yet — ~$16.43/mo, and needs the certificate for HTTPS.                                                                                                                                                           |
| **ECR repositories**        | `ecr:CreateRepository` **DENIED** — tested in us-east-2, not a region artefact.                                                                                                                                      |
| **ECS clusters / services** | Blocked on the IAM roles below.                                                                                                                                                                                      |
| **IAM roles**               | `iam:CreateRole` **DENIED**.                                                                                                                                                                                         |

### UNBLOCKED 2026-09-02 — access granted and verified

All four roles, the OIDC provider and the five ECR repositories now exist.
Verified by API, not by the email saying so:

| Resource                 | State                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `crm-ecs-execution-role` | trusts `ecs-tasks.amazonaws.com`, `AmazonECSTaskExecutionRolePolicy` + inline `crm-secrets-access` |
| `crm-task-role-staging`  | trusts `ecs-tasks`, S3 RW on `crm-staging-uploads-408568863712`                                    |
| `crm-task-role-prod`     | trusts `ecs-tasks`, S3 RW on `crm-prod-uploads-408568863712`                                       |
| `crm-github-deploy`      | for CI/CD via OIDC                                                                                 |
| OIDC provider            | `token.actions.githubusercontent.com`                                                              |
| ECR                      | `crm/directus`, `crm/socket-gateway`, `crm/ai-gateway`, `crm/workers`, `crm/bootstrap`             |

`iam:PassRole` on the execution role simulates as **allowed**, so services can
actually be created. The task-role S3 grants name the **account-ID-suffixed**
buckets correctly — worth checking, since that suffix was a late change.

> **The earlier confusion, for the record.** Rabih first attached
> `AmazonECSTaskExecutionRolePolicy` to the USER. That does nothing: the policy
> grants image-pull and log-write to whoever _assumes_ it, and the thing that
> pulls an image is the ECS task, not the human. It has to sit on a ROLE that
> ECS assumes. Now correct.
>
> **`AmazonEC2ContainerRegistryPowerUser` never included `ecr:CreateRepository`.**
> Read the policy document to confirm — it covers push/pull on repositories that
> already exist. The `ECS-DevOps` group has carried it all along while create
> stayed denied. `ecr:CreateRepository` had to be granted separately.

### Owner decisions still open

- Create the NAT gateway (~$32.85/mo)
- Pick a domain: `yiji-app.com` validates automatically here; `crm.anan.sa`
  needs someone outside this account to add DNS records
- Create the ALB once the certificate exists

---

## Accepted risk: secrets are plaintext

`ssm:PutParameter` and `secretsmanager:CreateSecret` are **both denied**, and the
owner chose not to request SSM access. Task definitions therefore carry secrets
as `environment` entries rather than `secrets` references.

A task-definition revision is immutable and permanent: anyone with ECS read
access can read those values, and rotating a password does not remove the old
one from revision history. See `deploy/aws/ecs/README.md`.

---

## Runtime design decisions (2026-09-02)

### Redis is SHARED between the environments, separated by namespace

Both environments use `redis-yiji`. That cluster is a **single node in one AZ
with no replica** (confirmed from its ElastiCache ENI names — `redis-yiji-0001-001`
and nothing else; note `yiji-prod-redis` is a _different_, two-node cluster and
is Yiji's, not ours).

Separation is `envNamespace()` in `packages/shared-config/src/redis.ts`:
**production is `yiji`, staging is `yiji-staging`**, derived from `NODE_ENV` so it
cannot be forgotten, overridable with `REDIS_NAMESPACE`. Production keeps the
bare name because its keys already exist under it — renaming would strand
in-flight jobs.

It covers all three shared surfaces. Before this change the prefix was
hardcoded `{yiji}` for both, so staging and production would have shared queues,
AI cache entries and rate-limit budgets:

- BullMQ queue keys (`bullPrefix`, inside `{}` for cluster co-location)
- The AI response cache (`aicache`)
- Rate limiters and the monthly AI spend cap (`rl`, `aicap`)

### No Redis replica — the queue is not the source of truth

A replica was considered (~$12/mo) and rejected. **Postgres is the source of
truth; Redis only schedules.** Every important job has a DB-driven sweep that
re-derives its own work — `runReconcile` re-reads open tickets and policies, the
coupon sweep finds everything approved-and-undelivered, the inactivity sweep and
report sync likewise. After a Redis outage the queue comes back empty and the
next sweep refills it.

`SWEEP_INTERVAL_MS` now controls all three (default **60s**, was a hardcoded
300s). Each sweep is one indexed query returning a handful of rows, so running
it five times as often is negligible, and it cuts worst-case recovery by 80% —
more than a replica would buy, for nothing. The normal path is still immediate:
an approval enqueues its job at once, so this interval bounds _recovery_, not
everyday latency.

**What the recovery depends on:** the workers service actually running. If it
dies quietly no sweep runs and the safety net is gone with no error anywhere —
which has happened here before (the SLA sweep was dead for the whole life of the
feature). That is what `scripts/create-alarms.sh` guards, and it is free.

### Task counts — two where an interruption is visible

ECS has **no standby mode**. Replacing a failed task takes 3-4 minutes (detect
~60s, start ~30s, Directus migrations 60-120s, health checks ~30s), and the same
applies to every deploy. A "warm standby" _is_ a second running task, billed
identically — so the choice is two tasks or minutes of downtime per release.

| service          | prod  | staging | if it stops for 3 minutes                     |
| ---------------- | ----- | ------- | --------------------------------------------- |
| `directus`       | **2** | 1       | everything stops — no data at all             |
| `socket-gateway` | **2** | 1       | customers see live chat disconnect            |
| `ai-gateway`     | 1     | 1       | AI panel errors; agents keep working          |
| `workers`        | 1     | 1       | jobs queue, picked up on restart (60s sweeps) |

Chosen deliberately over two-of-everything: it saves $18.02/mo, and the two
downgraded services are the two that degrade gracefully.

All four auto-scale on CPU 70% (`scripts/create-services.sh`), prod to 4/4/3/3,
so extra capacity is paid for only while it runs. Deployments use
`minimumHealthyPercent=100` with the circuit breaker and rollback enabled: old
tasks keep serving until new ones are healthy, and a failing deploy reverts
itself.

### Scripts

| script                                     | when                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `scripts/create-services.sh <env>`         | after cluster + task definitions + IAM roles exist                                            |
| `scripts/create-alarms.sh <env> <sns-arn>` | after the services exist (an alarm on a service with no datapoints sits in INSUFFICIENT_DATA) |

Container Insights must be enabled on each cluster or `RunningTaskCount` is
never published and the task-count alarms stay silent forever — the script
prints the command.

---

## Verified by running it (2026-09-02)

### The custom Directus image WORKS against crm_staging

`crm/directus:test` was run against the real staging database. Result:

```
Loaded extensions: directus-extension-app-roles-sync,
  directus-extension-cast-custom-field-value,
  directus-extension-lock-project-owner,
  directus-extension-notify-on-change,
  @directus-labs/super-header-interface
Server started at http://0.0.0.0:8055
```

**All five extensions load**, `app-roles-sync` included — the admin portal's
roles editor, which the ECS deployment could never have had. Data confirmed
present through the same connection: 17 users, 68 tickets, 100,506 revisions.

> ### `DB_SSL=true` BREAKS Directus — do not add it back
>
> Directus must have **only** `DB_SSL__REJECT_UNAUTHORIZED=false`. Adding
> `DB_SSL=true` alongside it kills the container at boot with
> `SELF_SIGNED_CERT_IN_CHAIN`: the parent set as a plain boolean overrides the
> nested object form that the double underscore builds, so node-postgres goes
> back to verifying RDS's untrusted CA.
>
> I had added `DB_SSL=true` to both the task definition and the compose overlay
> on the reasoning that it "turns SSL on". It does the opposite. Caught only by
> running the image; a review would not have found it. The Aug 2026 ECS task
> definition that worked against this same RDS also carried only the
> `__REJECT_UNAUTHORIZED` half.
>
> **The `bootstrap` task is the exception and keeps `DB_SSL=true`** — its own pg
> client reads `process.env.DB_SSL === 'true'` (`directus/bootstrap/src/env.ts`)
> for the raw connection its constraints step opens.

Two more findings from the run, both benign:

- **`getaddrinfo EAI_AGAIN`** on first attempt — the container could not resolve
  the RDS hostname through the corporate resolver. Worked around locally with
  `--dns 8.8.8.8 --add-host`. Not an issue on ECS, which uses VPC DNS.
- **Health reports `warn`, not `ok`** — `pg:responseTime` 186-213ms against a
  150ms threshold, because this ran from a laptop in Saudi Arabia to RDS in
  Ohio. From ECS in us-east-2 this is single-digit ms. PostGIS is also flagged;
  the app does not use geometry types.

Admin login returns `INVALID_CREDENTIALS` — expected. `ADMIN_EMAIL`/`ADMIN_PASSWORD`
seed an admin only on an EMPTY database; `crm_staging` was restored with its 17
existing users and their existing passwords.

### The staging portals are LIVE on CloudFront

Both bundles were built, given a staging `config.js`, and uploaded:

| portal | URL                                    |
| ------ | -------------------------------------- |
| agent  | https://d57v6u4ytjrj7.cloudfront.net/  |
| admin  | https://d1evkiaehtmzr0.cloudfront.net/ |

Verified: HTTP 200, `config.js` serves the `*.staging.crm.anan.sa` URLs with
`cache-control: no-cache`, hashed assets cached one year, and a deep link
(`/tickets/42`) returns 200 rather than S3's 404 — so the SPA router works.
Sign-in will fail until Directus is deployed; the page itself renders.

### ECS clusters

`crm-staging` and `crm-prod`, both ACTIVE, FARGATE + FARGATE_SPOT,
**Container Insights enabled** — which is what `RunningTaskCount` needs, so the
alarms in `scripts/create-alarms.sh` will actually fire. Empty clusters are free.
