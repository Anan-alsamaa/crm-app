# Deploying Directus to AWS ECS Fargate — runbook

A complete, AI-free procedure. Everything here was executed on **2026-08-06** against
account `408568863712` in **us-east-2 (Ohio)**; every id below is real.

> **Set the region to US East (Ohio) `us-east-2` in the console top-right before every
> step.** Drifting into another region is the single most common failure: the VPC
> dropdown silently offers a different account's default VPC and nothing matches.

---

## 0. What you need first

| Thing                | Value used                                                   |
| -------------------- | ------------------------------------------------------------ |
| Postgres host        | `test-yiji.ctqnuieahhb8.us-east-2.rds.amazonaws.com:5432`    |
| Database name        | `afcoCrm`                                                    |
| Database user        | `yijicrm` ← **lowercase**                                    |
| Redis (cluster mode) | `clustercfg.redis-yiji.6ea0wx.use2.cache.amazonaws.com:6379` |
| VPC                  | `vpc-08ea7d710f4596303` (`192.168.0.0/16`)                   |

### The permissions you actually need

This was deployed by a user in group **ECS-DevOps**, holding: `AmazonECS_FullAccess`,
`AmazonS3FullAccess`, `AmazonEC2ContainerRegistryPowerUser`, `CloudWatchLogsFullAccess`,
`IAMReadOnlyAccess`, `NetworkAdministrator`.

**`IAMReadOnlyAccess` cannot create roles.** That single fact shapes this whole runbook:

- **No task execution role** → **no CloudWatch logs**. Failures show only an exit code.
- **No task role** → **no S3** → `STORAGE_LOCATIONS=local`, and Fargate's filesystem is
  ephemeral, so **uploaded files are destroyed on every task replacement**.

Fargate will still run a task with no roles at all, provided all three hold:
the image is **public** (Docker Hub), there is **no `awslogs` block**, and there are
**no Secrets Manager / SSM references**. Break any one and the task will not start.

If you can get IAM help, ask only for this — it is small and standard:

> Create role `ecsTaskExecutionRole`, trusting `ecs-tasks.amazonaws.com`, with the AWS
> managed policy `AmazonECSTaskExecutionRolePolicy`. Also grant me `iam:PassRole` for it.

That one role restores logs. A second role with S3 read/write on the uploads bucket
restores durable file storage. See §9.

---

## 1. Find the network (without RDS permissions)

The ECS-DevOps group cannot read RDS, so the RDS console shows an empty list. Get the
network from the EC2 side instead.

1. Resolve the endpoints from any terminal:

   ```
   nslookup test-yiji.ctqnuieahhb8.us-east-2.rds.amazonaws.com    -> 18.223.62.15  (PUBLIC)
   nslookup clustercfg.redis-yiji.6ea0wx.use2.cache.amazonaws.com -> 192.168.120.118 (private)
   ```

   A public RDS address means the task reaches the database over the internet; no VPC
   peering or private routing is required. The private Redis address tells you the VPC
   range (`192.168.0.0/16`).

2. **EC2 → Network Interfaces**, search `ElastiCache`. Match the interface whose
   **Primary private IPv4** equals the Redis IP above. Its row gives you the **VPC**,
   **subnet** and **security group** — here `sg-0cd4698b2c26e93c0` (named `default`).

3. **VPC → Your VPCs** — confirm the CIDR matches (`192.168.0.0/16`).

---

## 2. Security groups

**Create the task security group.** EC2 → Security Groups → Create:

- Name `yiji-crm-ecs-tasks`, VPC `vpc-08ea7d710f4596303`
- Inbound: **Custom TCP 8055** from **My IP** (temporary direct access; removed in §8)
- Result: `sg-01d8a73e8d900684c`

**Redis access — change nothing.** Inspect Redis's security group
`sg-0cd4698b2c26e93c0`. It already contains:

```
All traffic   source: sg-0cd4698b2c26e93c0   (self-referencing)
```

So any resource **that is a member of that group** can reach Redis. Attach that group
to the ECS task as a _second_ security group rather than editing it.

> **Do not add `6379 from 0.0.0.0/0` here.** That group is shared with a **production**
> Redis cluster and MSK brokers — a rule added for one member applies to all of them.
> Security group rules are allow-only and additive, so they can never break existing
> access, but they can grant far more than you intend.

---

## 3. ECS cluster

ECS → Clusters → **Create cluster** → name `yiji-crm` → **AWS Fargate (serverless)** only.

---

## 4. Task definition

ECS → Task definitions → **Create new task definition with JSON**. Paste
`deploy/aws/directus-taskdef-alb.json` from this repo and set `DB_PASSWORD`.

Critical details, each of which cost a debugging cycle:

| Field                                 | Why it matters                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"DB_USER": "yijicrm"`                | **Postgres identifiers are case-sensitive on connect.** `Yijicrm` returns `28P01 password authentication failed` — _identical to a wrong password_. Verify the exact case in pgAdmin. Same trap for `DB_DATABASE`. |
| `DB_SSL__REJECT_UNAUTHORIZED=false`   | RDS presents a CA the container does not trust.                                                                                                                                                                    |
| no `executionRoleArn` / `taskRoleArn` | Cannot be created; their presence would fail the task.                                                                                                                                                             |
| no `logConfiguration`                 | `awslogs` requires the execution role. Including it is what turns "no logs" into "will not start".                                                                                                                 |
| `KEY` / `SECRET`                      | Stable UUIDs. **Changing them invalidates every session and token.** Store them somewhere permanent.                                                                                                               |
| `startPeriod: 120`                    | Directus runs migrations on first boot.                                                                                                                                                                            |

Secrets are plain environment variables because this account has no Secrets Manager
access. Every task-definition revision keeps a copy forever and anyone with ECS read
access can see them. Before real customer data, move them to SSM Parameter Store
SecureString and use a `secrets` block.

---

## 5. Load balancer (stable URL)

A Fargate task's public IP changes on every replacement, so it cannot be a URL.
CloudFront is not the answer either — it needs a stable origin. Use an ALB.

1. **ALB security group**: name `yiji-crm-alb`, VPC `vpc-08ea7d710f4596303`,
   inbound **HTTP 80 from `0.0.0.0/0`**. Result: `sg-0c6b667fc1dafe61a`
2. **Allow ALB → task**: on `sg-01d8a73e8d900684c` add inbound
   **Custom TCP 8055** with source **`yiji-crm-alb`**
3. **Target group**: EC2 → Target Groups → Create
   - Target type **IP addresses** (_not_ Instances — Fargate has no instances)
   - Name `yiji-crm-directus-tg`, **HTTP / 8055**, VPC as above
   - Health check path **`/server/health`**, healthy threshold **2**, success code **200**
   - **Register no targets** — ECS registers them automatically
4. **ALB**: EC2 → Load Balancers → Create → Application Load Balancer
   - Internet-facing, IPv4, VPC as above
   - **Mappings: at least two AZs**, each on a subnet showing `Route table: IGW (✓)`
   - Security group `yiji-crm-alb`
   - Listener **HTTP:80** → forward to `yiji-crm-directus-tg`
   - Wait for State **Active** (2–5 min), then copy the **DNS name**

Result: `yiji-crm-alb-1204214335.us-east-2.elb.amazonaws.com`

---

## 6. Service

ECS → Clusters → `yiji-crm` → Services → **Create**

| Field                         | Value                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Compute options               | **Launch type** → **FARGATE**                                                                                       |
| Family / Revision             | `yiji-crm-directus` / **LATEST**                                                                                    |
| Service name                  | `directus-alb`                                                                                                      |
| Desired tasks                 | `1`                                                                                                                 |
| **Health check grace period** | **180**                                                                                                             |
| VPC                           | `vpc-08ea7d710f4596303`                                                                                             |
| Subnet                        | `subnet-0f7abea49c8f4a19d` (SubnetPublicUSEAST2C)                                                                   |
| Security groups               | `sg-01d8a73e8d900684c` **and** `sg-0cd4698b2c26e93c0`                                                               |
| Public IP                     | **Turned on** — required to pull the public image                                                                   |
| Load balancing                | existing `yiji-crm-alb` → container `directus 8055:8055` → listener `HTTP:80` → target group `yiji-crm-directus-tg` |

Without the **180 s grace period** the ALB health-checks Directus before migrations
finish, marks it unhealthy, and ECS kills it in a loop.

A load balancer **cannot be added to an existing service** — if you forgot it, create a
new service and delete the old one.

---

## 7. Verify

1. EC2 → Target Groups → `yiji-crm-directus-tg` → **Targets** → wait for **healthy**
2. Open `http://<ALB-DNS>` (no `:8055` — the ALB listens on 80)
3. Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from the task definition

---

## 8. Clean up (do not skip)

1. **Delete the pre-ALB service** — two services writing to one database is a real
   hazard, and it doubles cost.
2. **Remove direct task exposure**: on `sg-01d8a73e8d900684c`, delete the
   `8055 from 0.0.0.0/0` rule (or narrow it to My IP). Once the ALB works, that rule
   only lets people bypass the load balancer and reach Directus admin directly.

---

## 9. Known gaps

| Gap                       | Fix                                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No logs**               | Get `ecsTaskExecutionRole`, then add `executionRoleArn` and the `logConfiguration` block from `deploy/aws/directus-taskdef.json`.                                                                                                                     |
| **Uploads are ephemeral** | Bucket `yiji-crm-directus-uploads` exists. Needs a task role (or `STORAGE_S3_KEY`/`STORAGE_S3_SECRET`), then `STORAGE_LOCATIONS=s3`.                                                                                                                  |
| **Redis disabled**        | `CACHE_ENABLED=false`. Directus's Redis client may not speak the cluster protocol that `clustercfg.` endpoints require — untested. Directus is fine on in-memory cache; our own services handle cluster mode (`packages/shared-config/src/redis.ts`). |
| **HTTP only**             | Request an ACM cert in us-east-2, add a `:443` listener to the same target group, switch the three URLs to `https://`, set `REFRESH_TOKEN_COOKIE_SECURE=true`.                                                                                        |

---

## 9b. socket-gateway: the stickiness step you cannot skip

When you add the gateway, its target group needs one setting that is easy to miss and
whose absence is invisible until the service scales.

Socket.IO negotiates on **HTTP long-polling first**, and that handshake spans several
requests. Behind an ALB with two or more tasks and no stickiness, those requests land on
different instances, and the instance that did not create the session answers
`Session ID unknown`. Clients then fail to connect, or connect and immediately drop.

**At one task everything works.** The failure appears only when you scale — after every
test has passed.

Two supported options. Pick one:

| Option          | `SOCKET_TRANSPORTS` | Target group stickiness | Trade-off                                                                                                                   |
| --------------- | ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **A** (default) | `polling,websocket` | **REQUIRED**            | Keeps the fallback for clients behind WebSocket-blocking proxies — the customer widget runs on arbitrary vendor storefronts |
| **B**           | `websocket`         | not needed              | Simpler and lighter, but no fallback                                                                                        |

**To enable stickiness (Option A):**

EC2 → Target Groups → select the gateway's target group → **Attributes** tab → **Edit** →
tick **Stickiness** → type **Load balancer generated cookie** → duration `1 day` → **Save**.

**Verification, either way:** the gateway states its own requirement at boot. With
`polling` enabled it logs a warning naming the stickiness dependency; with
`websocket` only it logs `websocket-only: no stickiness required`. Once CloudWatch logs
exist (§9) that line is the fastest confirmation you configured the pair consistently.

The task definition `deploy/aws/socket-gateway-taskdef.json` ships with Option A.

---

## 10. Debugging with no logs

You cannot read an error, so make the **exit code** carry the answer. `deploy/aws/dbprobe-taskdef.json`
overrides the entrypoint with a Node one-liner that tests TCP to Postgres:

| Exit code | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| **71**    | Connected — network is fine, the problem is credentials or database name |
| **72**    | Timed out — a security group is dropping packets                         |
| **73**    | Refused — wrong port, or not accepting remote connections                |
| **70**    | DNS or other error                                                       |

Run it as a one-off task (Clusters → Tasks → **Run new task**), then read
**Containers → Exit code**. Stopped tasks are hidden until you set the filter to
**Any desired status**.

This one probe eliminated security groups, subnets and routing in ten seconds and
pointed straight at the lowercase-username bug in §4.

---

## 11. Provisioning the schema

An empty Directus has none of the CRM's collections. From a machine that can reach both
the ALB and Postgres:

```bash
cd directus/bootstrap
DIRECTUS_INTERNAL_URL=http://<ALB-DNS> \
DIRECTUS_ADMIN_EMAIL=<admin email> \
DIRECTUS_ADMIN_PASSWORD=<admin password> \
DB_HOST=test-yiji.ctqnuieahhb8.us-east-2.rds.amazonaws.com \
DB_PORT=5432 DB_DATABASE=afcoCrm DB_USER=yijicrm DB_PASSWORD=<password> \
DB_SSL=true \
pnpm apply
```

`DB_SSL=true` is required: the constraints step connects to Postgres **directly** (raw
index SQL the Directus API cannot express) and RDS refuses plaintext.

Then `pnpm verify` to confirm every collection, role and permission exists.

The bootstrap is **idempotent** — safe to re-run; every step tolerates "already exists".
It provisions **schema, roles, permissions and flows — not row data**. Production should
start empty; do not copy local demo records.
