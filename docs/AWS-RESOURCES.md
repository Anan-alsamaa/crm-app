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
| `scripts/create-listener-rules.sh <env>`   | after the target groups exist — **required, see below**                                       |
| `scripts/create-alarms.sh <env> <sns-arn>` | after the services exist (an alarm on a service with no datapoints sits in INSUFFICIENT_DATA) |
| `scripts/deploy-portals.sh <env> [app]`    | after building the portals — never a bare `aws s3 sync`, which deletes `config.js`            |

**Do not skip `create-listener-rules.sh`, and do not hand-build the routing.**
A missing rule fails SILENTLY: the path falls through to the default target and
Directus answers it with a confident `404 ROUTE_NOT_FOUND`. That is how the
eight AI endpoints were dead for the whole life of the staging deployment —
every AI feature 404'd, and because the wrong service answered, the AI
gateway's own log showed nothing. The staging rules were all built by hand and
recorded nowhere until 2026-09-04.

Note the **5 condition values per rule** limit, and that two path-pattern
conditions on one rule are ANDed rather than ORed — so a longer path list needs
more RULES, not more conditions. The eight AI endpoints are split across
priorities 21 and 22 for this reason.

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

---

## Staging is LIVE (2026-09-03)

All four services running on ECS Fargate, HEALTHY, deployments COMPLETED:

| service          | task definition                | state             |
| ---------------- | ------------------------------ | ----------------- |
| `directus`       | `crm-staging-directus:2`       | RUNNING / HEALTHY |
| `socket-gateway` | `crm-staging-socket-gateway:4` | RUNNING / HEALTHY |
| `ai-gateway`     | `crm-staging-ai-gateway:3`     | RUNNING / HEALTHY |
| `workers`        | `crm-staging-workers:2`        | RUNNING / HEALTHY |

### Three bugs the deployment found — none reproducible locally

**1. `logs:CreateLogGroup` is NOT in `AmazonECSTaskExecutionRolePolicy`.** Tasks
died at PROVISIONING with a `ResourceInitializationError` that reads like a
logging misconfiguration; the cause was a missing IAM action. The task
definitions had `awslogs-create-group: true`, which asks the ECS agent to create
the group at task start. **Fix:** create the ten log groups up front (a user
has the permission even where the role does not) and drop the flag. Doing it
this way also allowed retention to be set — 7 days staging, 30 production —
which is the log cost control from the finance document actually enforced.

**2. `Redis is already connecting/connected`** (commit `7a911b4`). A real
application bug. Standalone ioredis is lazy and must be told to connect; a
**Cluster connects eagerly in its constructor** and throws if `connect()` is
called as well. `createRedis` returns whichever the URL implies, so the
unconditional call worked against local standalone Redis and failed only against
ElastiCache in cluster mode. **This class of bug cannot be caught locally.**

**3. The container health check killed its own task** (commit `cbf65cb`).
socket-gateway's check hit `/ready`, which asserts _Directus is reachable_. ECS
treats a failing container health check as grounds to replace the task, so the
gateway destroyed itself in a loop because another service had no DNS yet.
`/health` answers liveness and is what a container check must use; readiness
belongs on the load balancer target group, where "not ready" means "do not route
to me" rather than "replace me".

### Monitoring

SNS topic `arn:aws:sns:us-east-2:408568863712:crm-alerts` and seven staging
alarms: one per service for task count, Directus CPU and memory, and log volume.

> **The topic has NO subscriber.** `SNS:Subscribe` is denied for this user, so
> alarms fire and show in the console but **no email is delivered**. Add a
> subscription in the SNS console and confirm the emailed link, or the alarms
> are decoration.

### Still denied, and what it blocks

| Action                   | Blocks                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `iam:PutRolePolicy`      | Adding S3 write to `crm-github-deploy`. **CI portal uploads will fail** until Rabih adds it. |
| `SNS:Subscribe`          | Alarm emails.                                                                                |
| `cloudwatch:ListMetrics` | Only inspection; alarms themselves work.                                                     |

---

## POST-DEPLOYMENT TASK: proper hostnames

**Deferred 2026-09-03 by the owner. Do this after production is live and stable.**

Staging and production currently reach their backend services through
CloudFront's own `*.cloudfront.net` domains. That works and is secure —
CloudFront issues a free certificate for its own domain, the browser sees valid
HTTPS, and secure session cookies function — but the URLs are opaque
(`d1a2b3c4.cloudfront.net`) rather than `api.crm.yiji-app.com`.

**Why it was deferred:** `acm:RequestCertificate` AND `acm:ImportCertificate`
are both DENIED for `e.habibi@anan.sa` (tested 2026-09-03). A custom domain on
either CloudFront or an ALB requires an ACM certificate, so proper hostnames
cannot be configured at all from this account.

### The target

| environment | intended names                                   |
| ----------- | ------------------------------------------------ |
| production  | `*.crm.yiji-app.com` — api, ws, ai, agent, admin |
| staging     | `*.crm-staging.yiji-app.com` — same five         |

Verified free: no `crm*` record exists in `yiji-app.com` (48 records, all
explicit, **no wildcard**), Route 53 is authoritative for the zone, and there
are no CAA records to block issuance. Adding these is purely additive — it
cannot disturb Yiji's records, each of which independently aliases its own EKS
load balancer.

### Two routes, either works

**A. ACM access from Rabih** — `acm:RequestCertificate` +
`acm:DescribeCertificate`. Certificates are free. Then request
`*.crm.yiji-app.com` and `*.crm-staging.yiji-app.com`, add the validation
CNAMEs, attach to the ALB listener, point the DNS records at it.

**B. Cloudflare, via `anan.sa`** — that domain's DNS is on Cloudflare
(`elma/salvador.ns.cloudflare.com`), which issues its own free certificates and
needs no AWS permission. A smaller ask than an IAM grant, but a different owner.

> **Do NOT reuse Yiji's existing `*.yiji-app.com` certificate.** It is attached
> to their production load balancer; sharing it means a deletion or a failed
> renewal on their side takes the CRM down too. Request separate ones — they
> cost nothing.

### The switch is cheap

Roughly 20 minutes, no rebuild, no downtime: new certificate, new DNS records,
one listener update, regenerate `config.js` and re-upload the portals. The
portals resolve their URLs at RUNTIME (`resolveUrl`, `/config.js`), which is
precisely what makes a hostname change not a rebuild.

---

## Edge: ALB + CloudFront (2026-09-03)

TLS comes from **CloudFront's own certificate** on `*.cloudfront.net`, which is
free and needs no ACM permission — see the deferred-hostnames task above for why
ACM is unavailable.

```
browser --HTTPS--> CloudFront --HTTP--> ALB --> ECS tasks (private subnets)
          free cert            inside AWS
```

| Resource           | Id                                                  |
| ------------------ | --------------------------------------------------- |
| ALB `crm-alb`      | `crm-alb-220616707.us-east-2.elb.amazonaws.com`     |
| ALB security group | `sg-0a10756deb960ec6f`                              |
| Target groups      | `crm-stg-directus`, `crm-stg-socket`, `crm-stg-ai`  |
| API distribution   | `E2BHUTOA7A1WLB` -> `d2vi34f7wgjecb.cloudfront.net` |

### The ALB is NOT open to the internet

Inbound is a single rule allowing HTTP 80 from the AWS-managed prefix list
`pl-b6a144df` (`com.amazonaws.global.cloudfront.origin-facing`) — CloudFront
edge servers only. Verified: a direct curl to the ALB from outside times out.
It is `internet-facing` in the AWS sense (public subnets, routable) but refuses
everything that is not CloudFront.

### Routing is by PATH, not by header

The first design routed on an `X-CRM-Target` header. **That does not work**: the
Directus SDK cannot send custom headers, so internal service-to-service calls
would never match a rule.

Now: **Directus is the listener's DEFAULT action** (it owns `/items`, `/auth`,
`/assets`, `/server/*`), with two path rules above it —
`/socket.io/*,/webhooks/*,/jobs/*,/walk-in/*` to socket-gateway and
`/ai/*,/assist/*,/commerce/*` to ai-gateway.

> ### The deadlock this also fixed
>
> socket-gateway's **load-balancer** health check was `/ready`, which asserts
> Directus is reachable — and Directus is reached THROUGH this ALB. So the task
> could not become healthy until it was already receiving traffic. It cycled
> `draining` -> gone, forever.
>
> The LB check is now `/health`. The rule: **`/health` decides whether to route
> to a task; `/ready` describes whether its dependencies are up.** Using the
> latter for routing is circular whenever services talk to each other through
> the same load balancer.

### Services reach Directus through the ALB, not a public URL

`DIRECTUS_INTERNAL_URL` and `AI_GATEWAY_URL` are `http://{{ALB_HOST}}`,
substituted per environment at registration. The call stays inside the VPC —
no NAT data charge, lower latency — and it does not depend on CloudFront
existing, which is what broke the bootstrap ordering before.

**`{{ALB_HOST}}` is a placeholder deliberately.** A literal ALB hostname in the
task definition would give production staging's load balancer.

### Stickiness on the socket target group

Enabled (`lb_cookie`, 1 day). Socket.IO negotiates over HTTP long-polling first
and that handshake spans several requests; without stickiness they land on
different tasks and the one that did not create the session answers
`Session ID unknown`. **It works at one task** — the failure appears only when
you scale, after every test has passed.

### Yiji untouched — verified after every step

48 DNS records (unchanged), both `k8s-*` load balancers active, their
`*.yiji-app.com` certificate ISSUED, and the shared security group
`sg-0cd4698b2c26e93c0` still on its original 2 rules. Everything here is
additive and separate.

---

## Shared-cost allocation, and one thing worth more than the split

Two costs serve BOTH environments and are billed once: the NAT gateway
($32.85/mo) and the ALB ($16.43/mo). They are **fixed hourly charges** — the
same whether either environment sends one request or a million — so how they are
apportioned is an accounting choice, not a lever on the bill.

**Split 20/80, test/live** (owner's call). Reasoning: staging is exercised
occasionally by one person; production carries the whole team all day plus
customer chat.

> **The two resources do not actually deserve the same ratio.** The ALB is
> request-driven, so 20/80 arguably still flatters staging — the real figure is
> nearer 5/95. The NAT is the opposite: staging's background sweeps run 24/7 on
> the same timer as production's, Directus reaches RDS over its PUBLIC endpoint
> so every query crosses the NAT, and image pulls are ~230 MB for Directus
> alone. A defensible NAT split is nearer 35/65.
>
> Splitting them separately (NAT 35/65, ALB 10/90) moves **$3.28**. Not worth
> the extra explanation on a document already with finance, and the two biases
> roughly cancel.

### Staging runs the SAME sweep interval as production — deliberately

Both are **60s**. This was briefly changed to 300s for staging on the reasoning
that it idles most of the time and 43,200 sweeps a day costs log volume for
nothing. **That was wrong**, and the reason is worth keeping.

Staging exists to WATCH a change behave: raise a ticket and see the SLA warning
fire, approve a coupon and see it queue. At a 5-minute interval you sit waiting,
or conclude the feature is broken when it is merely slow. **A test environment
that behaves differently from production is not testing production.**

The saving was a few dollars of CloudWatch ingestion. The cost would have been
trusting what you observe there. Keep them identical.

---

## The ALB lockdown blocked the services from each other (2026-09-03)

Two decisions that were each right alone and broken together:

1. The ALB security group accepts **only** AWS's CloudFront prefix list
   (`pl-b6a144df`) — so nothing but CloudFront can reach it from outside.
2. `DIRECTUS_INTERNAL_URL` points services at **that same ALB**, so
   service-to-service calls go out through the front door and back in.

The ai-gateway's `whoAmI` call to Directus's `/users/me` therefore hit a
security group that did not know it, and **timed out** after 5s.

**What made it expensive:** the failure surfaced as
`{"error":"Invalid or expired session"}` — an auth message for a network
problem. Every instinct says "the token is wrong". The token was fine; the
tell was `"responseTime":5001` in the gateway's log, exactly matching the
5-second `AbortSignal.timeout(5_000)` in `whoAmI`.

**Fix:** allow the tasks' own security group (`sg-06ca4c19fa44b2dc3`) inbound
on 80 to the ALB SG. The ALB stays closed to the internet; it now accepts
CloudFront **and** the services.

```
80  pl-b6a144df             <- CloudFront edge
80  sg-06ca4c19fa44b2dc3    <- the services themselves
```

> **Prefix-list rules count once per CIDR.** CloudFront's list is ~55 entries,
> which nearly exhausts a security group's default 60-rule quota on its own —
> that is why the extra per-service listener ports had to be abandoned earlier.
> Budget for it before adding more rules to this group.

> **A duration in a log is evidence.** `responseTime` landing exactly on a
> configured timeout means a network path, not a credential — whatever the
> error message claims. Check the number before believing the words.
