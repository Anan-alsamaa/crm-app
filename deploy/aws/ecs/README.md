# ECS Fargate task definitions

Six task definitions, parameterised by environment. Written 2026-09-02 for the
architecture decided in `docs/ECS-RETIREMENT-AND-STAGING-CUTOVER.md`.

```
directus.json         Fargate service, behind ALB
socket-gateway.json   Fargate service, behind ALB (WebSocket)
ai-gateway.json       Fargate service, behind ALB
workers.json          Fargate service, NO inbound (no target group)
bootstrap.json        one-shot RunTask, not a service
```

The portals are **not** here: they are static bundles on S3 + CloudFront. Running
nginx in Fargate to serve static files costs ~$18/mo each and buys nothing.

---

## These are TEMPLATES — substitute before registering

Every file contains placeholders. Substitute them, do not edit by hand:

| Placeholder      | Staging        | Production |
| ---------------- | -------------- | ---------- |
| `{{ENV}}`        | `staging`      | `prod`     |
| `{{IMAGE_TAG}}`  | `main`         | `v1.x.x`   |
| `{{ACCOUNT_ID}}` | `408568863712` | same       |
| `{{REGION}}`     | `us-east-2`    | same       |

```bash
sed -e "s/{{ENV}}/staging/g" -e "s/{{IMAGE_TAG}}/main/g" \
    -e "s/{{ACCOUNT_ID}}/408568863712/g" -e "s/{{REGION}}/us-east-2/g" \
    deploy/aws/ecs/directus.json > /tmp/td.json
aws ecs register-task-definition --cli-input-json file:///tmp/td.json
```

CI does this substitution itself — see `.github/workflows/deploy.yml`.

---

## The two roles, and why nothing works without them

Both are referenced by every task definition here. **They do not exist yet**
(`iam:CreateRole` is denied on this account — tested 2026-09-02).

**`crm-ecs-execution-role`** — used by the ECS _agent_, before your container
starts. Trusts `ecs-tasks.amazonaws.com`; attach the AWS-managed
`AmazonECSTaskExecutionRolePolicy`, plus `ssm:GetParameters` on
`/crm/{{ENV}}/*`. It does three things:

- writes container logs to CloudWatch — **without it there are no logs at all,
  only an exit code**, which is what the 2026-08-06 deployment lived with;
- pulls images from ECR — **without it ECR is unusable**, which is why that
  deployment ran a public Docker Hub image;
- resolves `secrets:` from SSM — without it every password sits in plaintext in
  the task definition, where every revision keeps a copy for ever.

**`crm-task-role-{{ENV}}`** — used by _your container_, while running. Trusts
`ecs-tasks.amazonaws.com`; needs `s3:GetObject/PutObject/DeleteObject` on
`arn:aws:s3:::crm-{{ENV}}-uploads/*` and `s3:ListBucket` on the bucket. Without
it Directus cannot reach S3, `STORAGE_LOCATIONS` falls back to `local`, and
**every attachment is destroyed on each task replacement** — silently, while
Directus keeps serving rows that reference the missing files.

`iam:PassRole` on both is also required, or ECS cannot hand them to a task. It
is a _separate_ permission from `iam:CreateRole`: you can be allowed to create a
role and still be refused permission to use it.

> If Rabih will not grant `iam:CreateRole`, the smaller ask is for **him** to
> create these two roles and grant `iam:PassRole` on them. That is enough — the
> create permission is not needed at all.

---

## Secrets — PLAINTEXT, and why

> **This is a known, accepted risk (owner's decision, 2026-09-02), not an
> oversight.** Both secret stores are DENIED on this account, tested:
> `ssm:PutParameter` and `secretsmanager:CreateSecret` both return
> AccessDeniedException. The owner chose not to request SSM access.

So secrets ship as plain `environment:` entries. Each appears in these files as
a placeholder — **the real values are never committed**:

```
{ "name": "DB_PASSWORD", "value": "{{SECRET:DB_PASSWORD}}" }
```

The deploy step substitutes them from `.env.staging` / `.env.prod` (gitignored)
at registration time.

**What this costs you.** A task-definition revision is immutable and permanent:
anyone with ECS read access in the account can read these values, and every
revision keeps its own copy for ever. Rotating a password does not remove the
old one from history, and deregistering the revision does not either. Treat any
value that goes in this way as disclosed, and rotate it at source if the account
is ever compromised.

Affected: `DB_PASSWORD` (the RDS instance is SHARED with other teams),
`DIRECTUS_KEY`/`DIRECTUS_SECRET` (changing them invalidates every session),
`YIJI_ADMIN_PASSWORD` (authorises real coupon grants), `SMTP_PASSWORD`,
`GEMINI_API_KEY`, the three `SVC_*` tokens.

**If SSM access is ever granted**, swap each back to a `secrets:` entry pointing
at `arn:aws:ssm:us-east-2:408568863712:parameter/crm/<env>/<NAME>`. That form
was written first and is a straight revert.

## The five traps these files already handle

Each cost a debugging cycle on 2026-08-06. They are encoded here so they cannot
recur, but they are invisible if you rewrite these files from scratch.

**1. `DB_USER` is `yijicrm` — lowercase.** Postgres identifiers are
case-sensitive on connect. `Yijicrm` returns `28P01 password authentication
failed`, _identical to a wrong password_, so it reads as a credentials problem
and costs an hour. Same trap for the database name.

**2. Health check grace period 180s** (set on the _service_, not here). Directus
runs migrations on first boot; without the grace period the ALB health-checks it
too early, marks it unhealthy, and ECS kills it in a loop.

**3. Sticky sessions on the socket-gateway target group.** Socket.IO negotiates
over HTTP long-polling first, spanning several requests. Behind an ALB with 2+
tasks and no stickiness they land on different tasks, and the one that did not
create the session answers `Session ID unknown`. **Everything works at one
task** — the failure appears only when you scale, after every test has passed.
Enable it on the target group: Attributes → Stickiness → load balancer generated
cookie → 1 day.

**4. `DB_SSL__REJECT_UNAUTHORIZED=false`.** RDS presents a CA the container does
not trust and node-postgres verifies by default. The `bootstrap` job
additionally needs `DB_SSL=true`, because its constraints step opens its own raw
Postgres connection and **runs last** — a miss there fails at the very end of an
otherwise successful apply and reads as a schema bug.

**5. `STORAGE_LOCATIONS=s3`, always.** See the task role above. On Fargate,
`local` is data loss on a delay.

---

## Redis and the single-shard assumption

`REDIS_URL` points at the cluster-mode `clustercfg.` endpoint. Our services
detect that hostname and build a cluster-aware client with the `{yiji}` hash tag
(`packages/shared-config/src/redis.ts`), so BullMQ's Lua scripts do not fail
with CROSSSLOT.

**Directus's own Redis client is not cluster-aware, and this DID break — so
`CACHE_ENABLED=false` (2026-09-04).**

The prediction below was that a single-shard cluster is safe because no key
ever needs a `MOVED` redirect. That part is true. The failure was somewhere
else entirely, and worse:

Directus **purges its cache by deleting many keys in ONE command**. A cluster
refuses a multi-key command whose keys span slots — even on one shard, because
the check is on the SLOT, not the node:

    WARN: [cache] ReplyError: CROSSSLOT Keys in request don't hash to the same slot

It is logged as a **WARN and execution continues**, so `CACHE_AUTO_PURGE=true`
never actually purges and every later read serves the pre-write value.

> **The failure mode is what makes this dangerous.** A write returns **200 with
> the new value in the body** and **is recorded in `directus_revisions`** — API
> and audit trail both look correct. Only a separate, later read is wrong. It
> presents as "the button does nothing": on staging it was reported as
> "mark as solved does nothing" and "the approved coupon still shows pending",
> and both were chased as session and cache-invalidation bugs in the FRONTEND
> before anyone looked at the Directus log.

`CACHE_ENABLED=false` is the fix here: reads on this dataset are single-digit
ms, so the cache was buying very little. To re-enable it, Directus needs a
**standalone** (non-`clustercfg.`) endpoint — not another shard count.

**`RATE_LIMITER_STORE=redis` is unaffected and stays on**: it issues
single-key operations, which a cluster handles normally.

**Any write path must be verified by reading back on a SEPARATE request.**
`scripts/test-staging.sh` section 7 does this now; a 200 on the write proves
only that it was accepted.

Note the health payload names checks by **role, not backend**: there is no
`redis` key, so grepping for one returns nothing and reads as "Redis is off"
when it is connected. Look for `cache`.

Staging and production share the ElastiCache cluster but use different key
prefixes, so they cannot collide.
