# What to ask your manager for — the complete list

_So you ask once, not five times over a fortnight. Everything below is derived
from what the deployment actually touches; nothing is speculative._

---

## The short version (paste this)

> I'm deploying the CRM to AWS (staging + production). I need permissions in
> account `408568863712`, region `us-east-2`:
>
> - **SES** — create identity, request production access, create SMTP credentials
> - **RDS** — create one PostgreSQL instance
> - **ElastiCache** — create one Redis node
> - **EC2** — launch 2 instances, create security groups and 1 key pair
> - **VPC** — read existing subnets (not create)
> - **DNS for `crm.anan.sa`** — CNAME + A records (this may be a different team)
>
> Budget is roughly **$75/month for both environments**. Everything is in one
> region and one VPC.

---

## The detail, if they ask

### 1. SES — email

| need                      | why                                                   |
| ------------------------- | ----------------------------------------------------- |
| Create identity (domain)  | The app cannot send password-reset email without it   |
| Request production access | SES sandbox only sends to manually-verified addresses |
| Create SMTP credentials   | Creates one IAM user with send-only permission        |

Cost: **~$0** (~$0.10 per 1,000 emails; this app sends hundreds a month).

> The SMTP credential is an IAM user with `ses:SendRawEmail` only. If your
> manager is uneasy about IAM user creation, they can create it and hand you
> the credentials — you do not need the IAM permission yourself.

### 2. RDS — the database

One PostgreSQL 16 instance, `db.t4g.micro`, ~$13/month. Two databases on it
(`crm_prod`, `crm_staging`).

**This is the one worth explaining**, because you are asking to replace
something that already works. The reason is operational control: the current
instance is administered by someone else, so you cannot rotate credentials,
change backup retention, or restore from a snapshot without going through them.
For a system holding customer complaint data, that is a real constraint rather
than a preference.

### 3. ElastiCache — the job queue

One Redis node, `cache.t4g.micro`, ~$12/month. **Cluster mode disabled** — the
job library uses features cluster mode splits across slots.

### 4. EC2 — where the app runs

| what          | size      | cost    |
| ------------- | --------- | ------- |
| `crm-staging` | t3.small  | ~$15/mo |
| `crm-prod`    | t3.medium | ~$30/mo |

Plus: **2 security groups** (one for the instances, one each for RDS/Redis), and
**1 key pair** for SSH.

### 5. VPC — read only

You need to _see_ the existing VPC and subnets to place things in them. You do
not need to create a VPC.

### 6. DNS — often a different team

Five hostnames, all under one subdomain:

```
agent.crm.anan.sa      the agent portal
admin.crm.anan.sa      the admin portal
api.crm.anan.sa        Directus
ws.crm.anan.sa         websockets
ai.crm.anan.sa         the AI gateway
```

Plus **three CNAME records** for SES domain verification.

> **Ask for the subdomain `crm.anan.sa`, delegated to you if possible.** It is
> the easiest thing for a DNS owner to say yes to, because a subdomain cannot
> affect `anan.sa` email or the website. And it covers both needs — SES
> verification and the five hostnames — in one request rather than two.

---

## What you do NOT need to ask for

Worth knowing so you don't over-ask and slow the approval down:

- **ACM / certificates** — the stack runs Caddy, which provisions Let's Encrypt
  certificates automatically and renews them. No AWS certificate involved.
- **ECR** — container images go to GitHub's registry (GHCR), which CI already
  pushes to. Nothing AWS-side.
- **S3** — Directus stores uploads on a local volume by default. Only needed if
  you later move file storage off the instance.
- **Load balancers** — Caddy on the instance does this. An ALB is ~$18/month
  per environment for no benefit at this size.
- **Secrets Manager / Parameter Store** — config lives in a `.env.prod` file on
  each instance, readable only by root.
- **Route53** — only if DNS moves to AWS. Records can be added wherever the
  domain is hosted today.

---

## Verify these BEFORE you ask

Five minutes now saves a second round-trip:

1. **Can you log into the AWS console at all?** If not, that is the first ask
   and everything else waits on it.
2. **Which account?** The plan assumes `408568863712` (from the existing ECS
   runbook). If your access is to a different account, the existing RDS and
   Redis are not there and the plan needs adjusting — tell me.
3. **Region `us-east-2`.** Confirm what you can see is in Ohio; the console
   silently shows a different region's resources otherwise.
4. **Who owns `anan.sa` DNS?** IT, a hosting provider, or your manager? This is
   frequently a _different_ person from the AWS owner, and it is the item most
   likely to be slow.
5. **Is there an existing VPC in us-east-2?** If yes, use it. If the account is
   empty, someone needs to create one — small, but it is a step.
6. **Is there a budget or billing alarm** you should stay under? ~$75/month is
   small, but "I didn't know you were spending that" is an avoidable
   conversation.

---

## Order, and what blocks what

```
DNS access ──────────────┐
                         ├──▶ SES identity ──▶ production access (24-48h)
                         └──▶ the five hostnames ──▶ Caddy TLS on first boot

AWS console access ──▶ RDS ──┐
                  └──▶ Redis ─┼──▶ EC2 ──▶ first deploy
                              │
                        (no DNS needed for these)
```

**DNS is the long pole**, because SES production access cannot start until the
identity verifies, and Caddy cannot get certificates until the hostnames resolve
to the instance.

**RDS, Redis and EC2 need no DNS at all** — so if console access arrives first,
start there and let DNS catch up.
