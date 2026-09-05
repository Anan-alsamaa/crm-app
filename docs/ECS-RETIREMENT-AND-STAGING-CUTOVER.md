# Retiring the ECS Directus, and standing staging up on EC2

_Written 2026-09-02, while the deploy is blocked on one permission._

Two jobs, in this order:

1. **Stand staging up** on an EC2 box running `docker-compose.prod.yml`.
2. **Retire the ECS Directus** — but only once (1) is serving.

They are sequenced deliberately. The ECS stack costs roughly **$18/month for the
ALB** plus the Fargate task, and every day it stays up is money — but it is also
the only thing currently answering at a stable URL. Do not delete it first.

> **Read `STAGING-SETUP.md` alongside this.** That file records what was
> _verified_ (the database load, SMTP, the version traps). This file is the
> _procedure_. Neither repeats the other.

---

## 0. The one thing still blocking

**`ec2:CreateKeyPair` is denied** for `e.habibi@anan.sa`. Without a key pair
there is no SSH access to a new instance, and the whole of §2 is unreachable.

Two ways past it, either is fine:

- Rabih grants `ec2:CreateKeyPair`, or
- Rabih creates a key pair named `crm-staging` in **us-east-2** and sends the
  `.pem` out of band.

Everything else in §2 was tested and works: `ec2:RunInstances`,
`ec2:CreateSecurityGroup`. `ec2:AllocateAddress` (Elastic IP) is wanted at the
DNS step and is covered by `AmazonEC2FullAccess`.

> **`ec2:TerminateInstances` is denied too.** That is why `crm-access-test`
> (`i-074d05fe8afa6dfe5`) is still running and still billing. Ask for terminate
> in the same message — see §5. This account's grant is deliberately
> "deploy but do not delete", so **every deletion in §4 needs Rabih**.

---

## 1. What is being replaced, and why

The ECS Directus was stood up on 2026-08-06 and is wrong in four ways that
cannot be fixed on Fargate without more IAM than this account will get:

| Problem                     | Why it cannot be fixed there                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No extensions**           | All five live in `directus/extensions` and are **bind-mounted**. Fargate cannot bind-mount a host path. Without `app-roles-sync` the admin portal's roles editor does not exist.  |
| **No logs**                 | `awslogs` needs `ecsTaskExecutionRole`, which `IAMReadOnlyAccess` cannot create. Failures show only an exit code.                                                                 |
| **Uploads die on redeploy** | Fargate's filesystem is ephemeral and `STORAGE_LOCATIONS=local`. Every task replacement silently discards every attachment while Directus keeps serving rows that reference them. |
| **Schema 3 weeks stale**    | It points at `afcoCrm`, which is missing six collections and holds no business data.                                                                                              |

An EC2 box running the same `docker-compose.prod.yml` as production fixes all
four at once, and makes staging a real rehearsal for production instead of a
different architecture.

---

## 2. Stand staging up

### 2a. Launch the instance

Region **us-east-2 (Ohio)**. Set it in the console before every step — drifting
region is the most common failure here, because the VPC dropdown silently offers
a different default VPC and nothing matches.

| Field          | Value                                                 |
| -------------- | ----------------------------------------------------- |
| Name           | `crm-staging`                                         |
| AMI            | Ubuntu 22.04 LTS (x86_64)                             |
| Type           | `t3.small` (2 vCPU / 2 GB) — see the build note below |
| Key pair       | `crm-staging` (§0)                                    |
| VPC            | **default** `vpc-0036e2aa4b398c155`                   |
| Subnet         | any public subnet, auto-assign public IP **on**       |
| Storage        | 30 GB gp3                                             |
| Security group | new: `crm-staging-sg` (§2b)                           |

> **Why the default VPC and not the EKS one.** `RunInstances` is proven to work
> there. Launching into `vpc-08ea7d710f4596303` would put the box next to
> ElastiCache, but needs a subnet in that VPC plus a security-group change on a
> group **shared with production Redis and MSK brokers**. Not worth it for
> staging: Redis runs on the box instead (§2d).

> **t3.small cannot BUILD the images** — the TypeScript builds OOM and exit 137
> with no message about memory. Pull them from the registry. If you must build
> on a box, use a `t3.medium` for the build and then size back down.

### 2b. Security group

`crm-staging-sg`, inbound only:

| Port | Source      | Why                                 |
| ---- | ----------- | ----------------------------------- |
| 22   | **your IP** | SSH. Never `0.0.0.0/0`.             |
| 80   | `0.0.0.0/0` | Caddy — ACME HTTP-01 challenge      |
| 443  | `0.0.0.0/0` | Caddy — the only public app surface |

**No application port is opened.** Every container binds `127.0.0.1` and Caddy
is the sole public edge. If you find yourself opening 8055, stop: something else
is wrong.

### 2c. RDS must accept the new box

The database is the shared RDS at
`test-yiji.ctqnuieahhb8.us-east-2.rds.amazonaws.com`. Its endpoint is **public**
(18.223.62.15), so no VPC peering is needed — but its security group must allow
5432 from the staging box's IP.

**This account cannot read RDS at all**, so you cannot check or change this
yourself. It goes in the ask (§5). `scripts/deploy-staging.sh --check` proves it
either way in ten seconds, and distinguishes a blocked packet (timeout) from a
wrong port (refused).

### 2d. Host setup

```bash
ssh -i crm-staging.pem ubuntu@<elastic-ip>

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && exec newgrp docker

# The repo
sudo mkdir -p /srv/crm && sudo chown ubuntu:ubuntu /srv/crm
git clone <repo-url> /srv/crm && cd /srv/crm
```

Then copy the env file **by hand** — it is gitignored and holds every secret:

```bash
scp -i crm-staging.pem .env.staging ubuntu@<elastic-ip>:/srv/crm/.env.staging
ssh -i crm-staging.pem ubuntu@<elastic-ip> chmod 600 /srv/crm/.env.staging
```

### 2e. Fill the five URLs

`.env.staging` is complete except the hostnames, which need DNS (§3). Until DNS
exists you can run against the raw Elastic IP by setting these to
`http://<elastic-ip>:<port>` — the stack works, but browser cookie behaviour
(`REFRESH_TOKEN_COOKIE_SECURE=true`) means **logins will not persist over plain
HTTP**. Treat an IP-only run as a smoke test, not as staging being ready.

### 2e-bis. Ports — fine now, a conflict later

`.env.staging` sets **no** `*_PORT` overrides, so the compose defaults apply:
`8055 / 8080 / 8082 / 8081 / 8090 / 8092`. On a dedicated staging box that is
correct and needs no change.

**It stops being correct the moment production lands on the same host.**
`RELEASE.md` §2a plans exactly that, and the second `up` would fail on a port
collision — noisy, not silent, but confusing if you have forgotten this. When
that day comes, add the 9xxx block from `RELEASE.md` §2a to `.env.staging`; the
deploy script reads those same variables for its smoke checks, so it follows
automatically.

### 2f. Deploy

```bash
cd /srv/crm
./scripts/deploy-staging.sh --check       # preflight only, changes nothing
./scripts/deploy-staging.sh --bootstrap   # deploy + apply schema/roles/tokens
```

The script is idempotent. What it checks before touching anything, and why each
check exists:

- **placeholders** — `${VAR:?}` in compose catches _empty_, never a leftover
  placeholder string.
- **`YIJI_COUPON_DELIVERY=off`** — staging shares the real Yiji tenant, and
  delivery works from a _backlog_, so `on` sends every approved-undelivered
  coupon at once, to real customers, for real money.
- **`DB_DATABASE`** — refuses `afcoCrm` outright (the dead ECS database).
- **`REDIS_URL`** — refuses the `clustercfg.` endpoint, which is in another VPC
  and fails only later, at the first job, as `Failed to refresh slots cache`.
- **DNS + TCP to RDS** — and it rejects `10.1.10.22`, because the corporate
  resolver answers that for _any_ name and makes every reachability test lie.
- **the bundled postgres is absent** from the resolved config — staging uses
  RDS, and a silently-started local Postgres would be a second, empty database
  that everything appears to work against.

> `--bootstrap` is worth running once even though `crm_staging` was restored
> _with_ its schema: the bootstrap also seeds the **service accounts**. The ECS
> bootstrap skipped them because `SVC_*` were unset, and without those users the
> gateway, workers and ai-gateway cannot authenticate to Directus at all.

### 2g. TLS

Once DNS resolves (§3), add the Caddy overlay:

```bash
docker compose --project-name crm-staging --env-file .env.staging \
  -f docker-compose.prod.yml -f deploy/docker-compose.staging.yml \
  -f deploy/docker-compose.proxy.yml up -d
```

`BASE_DOMAIN` and `ACME_EMAIL` must be in `.env.staging`, and the DNS records
must already point at the box — Caddy's ACME challenge fails otherwise, and it
backs off, so a wrong record costs more than one retry.

---

## 3. DNS

Five names per environment, all pointing at the Elastic IP.

**Use a staging sub-domain, not an `-stg` suffix:**

```
BASE_DOMAIN=staging.crm.anan.sa
  -> agent.staging.crm.anan.sa   admin.staging.crm.anan.sa
     api.staging.crm.anan.sa     ws.staging.crm.anan.sa
     ai.staging.crm.anan.sa
```

`deploy/Caddyfile` is fully parameterised on `{$BASE_DOMAIN}` — every site block
and the CSP `connect-src` — so this form needs **no edit to the Caddyfile at
all**, and staging and production share one file. `RELEASE.md` §2b sketches an
`agent-stg.crm.example.com` style instead; that would mean hand-writing five
more site blocks and a second CSP. Prefer the sub-domain.

A wildcard `*.staging.crm.anan.sa` A record covers all five at once.

**Allocate the Elastic IP before creating the records.** Without one the public
IP changes on every stop/start, and the records silently point at nothing — or,
worse, at somebody else's instance.

---

## 4. Retire ECS — only after staging serves

Gate on all four, no exceptions:

- [ ] staging answers on all five hostnames over HTTPS
- [ ] both portals log in, and the admin roles editor loads (proves the
      extensions are mounted — the thing ECS could never do)
- [ ] `docs/RELEASE.md` §4 checklist passes
- [ ] nothing external points at the ALB DNS name

Then delete, in this order — **children before parents**, or the delete fails:

| #   | Resource       | Name / id                                          | Note                              |
| --- | -------------- | -------------------------------------------------- | --------------------------------- |
| 1   | ECS service    | `directus-alb` in cluster `yiji-crm`               | scale to 0 first, then delete     |
| 2   | ECS service    | `yiji-crm-directus-service-f2dn0cb6`               | the pre-ALB one, if still present |
| 3   | ALB listener   | HTTP:80 on `yiji-crm-alb`                          |                                   |
| 4   | ALB            | `yiji-crm-alb` (`...-1204214335.us-east-2.elb...`) | **this is the ~$18/mo**           |
| 5   | Target group   | `yiji-crm-directus-tg`                             | only after the listener is gone   |
| 6   | ECS cluster    | `yiji-crm`                                         | only after both services are gone |
| 7   | Security group | `sg-0c6b667fc1dafe61a` (`yiji-crm-alb`)            | only after the ALB is gone        |
| 8   | Security group | `sg-01d8a73e8d900684c` (`yiji-crm-ecs-tasks`)      | only after the tasks are gone     |
| 9   | EC2 instance   | `i-074d05fe8afa6dfe5` (`crm-access-test`)          | unrelated to ECS, still billing   |

**Do not touch `sg-0cd4698b2c26e93c0`.** It is the VPC default group, shared
with a **production** Redis cluster and MSK brokers. The ECS task was merely a
_member_ of it; no rule was ever added for us, and none should be removed.

**Leave alone:**

- **RDS `test-yiji`** — it hosts `crm_staging`, which is the staging database,
  plus several other teams' databases.
- **ElastiCache `redis-yiji`** — other workloads use it.
- **Database `afcoCrm`** — dead, but dropping it needs RDS permissions nobody
  here has, and it costs nothing beyond a little storage. Retire it with the
  owner separately rather than bundling it into this.
- **S3 `yiji-crm-directus-uploads`** — empty (uploads never worked). Harmless.

> **You cannot do any of steps 1–9 yourself.** `ecs:DeleteService`,
> `elasticloadbalancing:DeleteLoadBalancer` and `ec2:TerminateInstances` are all
> outside this account's grant, which allows create and not destroy. Either
> Rabih runs them, or he grants the deletes temporarily. Send him §4 verbatim —
> it is already ordered so the deletes cannot fail on a dependency.

---

## 5. The ask for Rabih

One message, everything in it:

> **1. `ec2:CreateKeyPair`** in us-east-2 — or create a key pair named
> `crm-staging` and send me the `.pem`. This is the only thing blocking the
> deployment.
>
> **2. RDS security group:** allow **TCP 5432** from the staging EC2 instance
> (I will send its IP once it launches) to
> `test-yiji.ctqnuieahhb8.us-east-2.rds.amazonaws.com`. I have no RDS
> permissions, so I cannot check or change this.
>
> **3. `ec2:TerminateInstances`** — `i-074d05fe8afa6dfe5` (`crm-access-test`) is
> running and billing from an access test, and I cannot stop it.
>
> **4. Delete the retired ECS stack** once I confirm staging is live — the ALB
> alone is about **$18/month**. Ordered list attached (§4 of this doc); it must
> be done in that order.
>
> Not needed any more: **SES access** and an **IAM SMTP credential**. The tenant
> has an Office 365 mailbox (`Yiji@anan.sa`) whose SMTP was verified on
> 2026-08-31, which also removes the 24–48h domain-verification wait.

---

## 6. What changed in the repo for this

| File                                | Why                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `deploy/docker-compose.staging.yml` | **new** — drops the bundled Postgres (staging uses RDS) and adds the TLS settings RDS needs. |
| `scripts/deploy-staging.sh`         | **new** — preflight + deploy + bootstrap + smoke, idempotent.                                |
| `.env.staging`                      | `REDIS_URL` emptied — it pointed at the cross-VPC ElastiCache.                               |

### The TLS gap this uncovered

`docker-compose.prod.yml` passes **no SSL settings to Directus**, because it was
written for a bundled Postgres on the same Docker network, where none are
needed. Against RDS that is not enough: RDS presents a CA the container does not
trust, and node-postgres verifies by default.

The 2026-08-06 ECS task definition already carried
`DB_SSL__REJECT_UNAUTHORIZED=false` against this same instance — so this is a
known-necessary setting, not a guess. The overlay supplies it, plus `DB_SSL=true`
for the bootstrap, whose constraints step opens its own raw Postgres connection
and **runs last** — without it the bootstrap fails at the very end of an
otherwise successful apply, and reads as a schema bug rather than a TLS one.

**This will matter for production too** if production ever points at a managed
database. Right now `docker-compose.prod.yml` alone cannot do that.
