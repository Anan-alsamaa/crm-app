# Yiji CRM — AWS Deployment Plan

> **Purpose of this document.** This is a complete, self-contained description of
> the Yiji CRM application and the plan to deploy it to AWS. Hand this to an
> assistant and ask it to expand any phase into click-by-click / CLI steps. It
> assumes **AWS ECS (Fargate)** for the backend, **S3 + CloudFront** for the
> frontends, **RDS** for Postgres, **ElastiCache** for Redis, plus S3, Secrets
> Manager, an ALB, and ECR.

---

## 1. What the application is (mental model)

One monorepo (pnpm + TypeScript) produces **two kinds of output**:

- **Backend = long-running programs** → deploy as **containers on ECS Fargate**.
- **Frontend = static files (HTML/JS)** → deploy to **S3 + CloudFront**.

Both depend on a **PostgreSQL database** and **Redis**. Redis is **mandatory**
(it powers the Socket.IO realtime adapter _and_ the BullMQ job queue).

Source repo: `https://github.com/AFCO-sources/Yiji-CRM.git` (mirror of the app;
the `main` branch is the complete application).

---

## 2. Runtime components inventory

| Component          | Tech                                                      | Container?         | Port(s)                                        | Public?                   | Depends on                                          |
| ------------------ | --------------------------------------------------------- | ------------------ | ---------------------------------------------- | ------------------------- | --------------------------------------------------- |
| **postgres**       | PostgreSQL 16                                             | (managed)          | 5432                                           | no (private)              | —                                                   |
| **redis**          | Redis 7                                                   | (managed)          | 6379                                           | no (private)              | —                                                   |
| **directus**       | Directus 11 (headless CMS/API + admin)                    | yes                | 8055                                           | **yes** (ALB)             | postgres, redis, S3 (uploads)                       |
| **socket-gateway** | Node + Socket.IO (Redis adapter)                          | yes                | 8080 (WS), 8081 (http health/metrics/webhooks) | **yes** (ALB, WebSockets) | redis, directus                                     |
| **ai-gateway**     | Node + Fastify (AI proxy → Gemini; commerce proxy → Yiji) | yes                | 8085                                           | internal only             | directus (verifies agent), Yiji API, Gemini         |
| **workers**        | Node + BullMQ (background jobs)                           | yes                | 8090 (health)                                  | internal only             | postgres/directus, redis, ai-gateway                |
| **agent-portal**   | React 18 + Vite SPA (nginx)                               | yes (or static)    | 80                                             | **yes**                   | directus, socket-gateway, ai-gateway (from browser) |
| **admin-portal**   | React 18 + Vite SPA (nginx)                               | yes (or static)    | 80                                             | **yes**                   | directus                                            |
| **chat-widget**    | Preact SPA (static)                                       | static             | —                                              | **yes**                   | socket-gateway                                      |
| **bootstrap**      | one-shot Directus schema/flows init                       | yes (RunTask once) | —                                              | no                        | directus, postgres                                  |

Dockerfiles already exist for: `services/socket-gateway`, `services/workers`,
`services/ai-gateway`, `apps/agent-portal`, `apps/admin-portal`,
`directus/bootstrap`. CI (`.github/workflows/deploy.yml`) already builds these
images (currently pushed to GHCR).

---

## 3. Target AWS architecture

```
                          Route 53 (DNS)
                                │
        ┌───────────────────────┼─────────────────────────────┐
        │                       │                              │
  CloudFront (CDN)         CloudFront                    Application
  app.<domain>            admin.<domain>                 Load Balancer (ALB, HTTPS)
  widget.<domain>              │                          │            │
        │                     │                     api.<domain>   gw.<domain>
   S3 (agent SPA)        S3 (admin SPA)             (Directus:8055) (socket:8080, WS)
   S3 (widget)                                            │            │
                                                     ┌────┴─────┬──────┴───────┐
                                                     │ ECS Fargate (private)   │
                                                     │  directus               │
                                                     │  socket-gateway         │
                                                     │  ai-gateway (internal)  │
                                                     │  workers (internal)     │
                                                     └────┬───────────┬────────┘
                                                          │           │
                                                    RDS Postgres   ElastiCache Redis
                                                          │
                                                    S3 (Directus uploads)

  Secrets Manager  ── injects env into every ECS task
  ECR              ── stores the 5–6 service images
```

- **VPC:** public subnets (ALB, NAT GW) + private subnets (Fargate tasks, RDS,
  ElastiCache). **You likely do NOT need to create a VPC** — the account's
  **default VPC** works; using it needs far fewer IAM permissions than creating one.
- **Internal service-to-service** (workers→ai-gateway, socket→directus): ECS
  **Service Connect** / Cloud Map, or the ALB's internal DNS.

---

## 4. Prerequisites & decisions (do first)

1. **Region:** pick one (e.g. `me-central-1` or `eu-central-1`) and stay in it.
2. **Domains** (needed early because the frontends bake their API URLs at build):
   - `app.<domain>` → agent portal
   - `admin.<domain>` → admin portal
   - `widget.<domain>` → chat widget
   - `api.<domain>` → Directus (ALB)
   - `gw.<domain>` → socket-gateway (ALB, WebSockets)
3. **ACM certificates:** request a cert covering those subdomains **in your region**
   (for the ALB) **and** a second one **in `us-east-1`** (required by CloudFront).
   Validate via Route 53.

---

## 5. Deployment sequence (bottom-up — each step feeds the next)

Build in this order because each layer needs the one below it to already exist.

**Phase 1 — Networking**
Use the default VPC, or create one with the "VPC and more" wizard (2 public + 2
private subnets, 1 NAT GW). Create security groups: `sg-alb` (443/80 from
internet), `sg-ecs` (from `sg-alb`), `sg-rds` (5432 from `sg-ecs`), `sg-redis`
(6379 from `sg-ecs`).

**Phase 2 — ECR + images**
Create one ECR repo per image: `directus-bootstrap`, `socket-gateway`, `workers`,
`ai-gateway`, `agent-portal`, `admin-portal`. Build & push (locally or via CI).
Portals are built later (Phase 9) because their URLs must be baked in.

**Phase 3 — Secrets Manager**
Create secrets for every sensitive value (see §7). ECS task defs reference them
via the `secrets:` block. Keep `DIRECTUS_KEY` / `DIRECTUS_SECRET` **stable
forever** (changing them invalidates sessions/tokens).

**Phase 4 — RDS (PostgreSQL 16)**
Private subnets, `sg-rds`, Multi-AZ for prod, create database `yiji_crm`.
Record the endpoint → `DB_HOST`, and creds into the secret.

**Phase 5 — ElastiCache (Redis 7)**
Private subnets, `sg-redis`. Record the primary endpoint → `REDIS_URL`.

**Phase 6 — S3**

- `yiji-directus-uploads` (private) — Directus file storage.
- `yiji-agent-portal`, `yiji-admin-portal`, `yiji-widget` (private + CloudFront OAC)
  — static hosting for the SPAs.

**Phase 7 — ECS cluster + ALB + backend services**

- Create an **ECS Fargate cluster**.
- Create an **ALB** (public subnets, `sg-alb`), HTTPS listener with the Phase-4
  cert. Host-based routing: `api.<domain>` → Directus target group (:8055),
  `gw.<domain>` → socket-gateway target group (:8080, **WebSockets enabled, long
  idle timeout**).
- Create task definitions + services (private subnets, `sg-ecs`), env from
  Secrets Manager + the RDS/Redis endpoints:
  - **directus** (:8055, ALB) — `STORAGE_LOCATIONS=s3` + S3 adapter env → uploads bucket.
  - **socket-gateway** (:8080 ALB + :8081) — Redis.
  - **ai-gateway** (:8085, internal, Service Connect) — Gemini + Yiji.
  - **workers** (no public port, internal) — Redis + `AI_GATEWAY_URL`.
- CloudWatch Logs group for each service.

**Phase 8 — Bootstrap Directus schema (run once)**
`aws ecs run-task` the **bootstrap** image once (after Directus + RDS are up) to
create the collections/flows/permissions. Verify `https://api.<domain>/server/health`.

**Phase 9 — Build & upload the frontends**
Now that `api.<domain>` / `gw.<domain>` exist, build each SPA with the real URLs
baked in (see §6, item 2), then upload:

```
aws s3 sync apps/agent-portal/dist  s3://yiji-agent-portal  --delete
aws s3 sync apps/admin-portal/dist  s3://yiji-admin-portal  --delete
aws s3 sync apps/chat-widget/dist   s3://yiji-widget        --delete
```

**Phase 10 — CloudFront + DNS**
One CloudFront distribution per static bucket (OAC, `us-east-1` cert, SPA
rewrite 403/404 → `/index.html`). Route 53: `app`/`admin`/`widget` → CloudFront;
`api`/`gw` → the ALB.

**Phase 11 — Verify** (see §11).

---

## 6. Critical app-specific gotchas (do NOT skip)

1. **Directus uploads must go to S3.** The dev setup uses a local volume, which
   is **ephemeral on Fargate** — uploads would vanish on restart. Set
   `STORAGE_LOCATIONS=s3` + the Directus S3 adapter env vars + a bucket.
2. **The frontends are configured at BUILD time.** Vite inlines the `VITE_*`
   values into the bundle, so you must build the portal/widget images (or the
   static bundles) with the **production URLs** and cannot change them at runtime:
   ```
   --build-arg VITE_DIRECTUS_URL=https://api.<domain>
   --build-arg VITE_SOCKET_URL=https://gw.<domain>
   --build-arg VITE_AI_GATEWAY_URL=https://<ai-gateway route>
   ```
   (the chat-widget also needs `VITE_SOCKET_URL` and its JWT secret).
3. **WebSockets:** socket-gateway must sit behind an ALB with WebSocket support
   and a long idle timeout; its Redis adapter needs ElastiCache reachable from
   the task subnet.
4. **Redis is mandatory** — Socket.IO scaling _and_ BullMQ both require it.
5. **Registry:** CI pushes to **GHCR**; ECS pulls most cleanly from **ECR** — add
   an ECR push step to `deploy.yml` or use ECR pull-through cache.
6. **ai-gateway → Yiji connectivity:** the ai-gateway calls the live Yiji API
   (`YIJI_API_URL`, `YIJI_API_KEY`) for the customer order panel. The task's
   subnet must have outbound internet (NAT GW) to reach `order.yiji-app.com`.
7. **Customer identity contract (chat widget):** the host page passes the customer
   identity as query params / JWT — `phone` (mandatory), `customer_id`, optional
   `name`/`email`, `vendor_id`. NOTE: the gateway keys contacts on **phone**
   (partial-unique per vendor) and does **not** currently normalize phone format
   or enforce a 1:1 `customer_id`↔phone — the host must send a consistent phone
   format and a stable `(phone, customer_id)` pair. (Optional hardening: normalize
   phone to E.164 + unique-index `external_customer_id`.)

---

## 7. Environment variables reference

Source of truth: `.env.prod.example` in the repo. Categorized by **where each
value belongs** in AWS.

### → AWS Secrets Manager (sensitive — never bake into images)

```
DIRECTUS_KEY            DIRECTUS_SECRET          (Directus — keep STABLE forever)
DIRECTUS_ADMIN_PASSWORD DB_PASSWORD
YIJI_JWT_SECRET         YIJI_WEBHOOK_SECRET      YIJI_API_KEY
GEMINI_API_KEY
SVC_GATEWAY_TOKEN       SVC_WORKERS_TOKEN        SVC_AI_TOKEN   (inter-service auth)
SMTP_PASSWORD
VITE_WIDGET_JWT_SECRET  (widget dev token secret — if used in prod)
```

### → Plain config (task-def env or SSM Parameter Store)

```
DB_HOST        (RDS endpoint)      DB_PORT (5432)   DB_USER   DB_DATABASE
REDIS_URL      (ElastiCache endpoint, e.g. redis://<host>:6379)
DIRECTUS_PUBLIC_URL     = https://api.<domain>
DIRECTUS_INTERNAL_URL   = http://directus.<service-connect-namespace>:8055
AI_GATEWAY_URL          = http://ai-gateway.<service-connect-namespace>:8085
CORS_ORIGIN             = https://app.<domain>,https://admin.<domain>
WIDGET_CORS_ORIGIN      = https://widget.<domain>
DIRECTUS_ADMIN_EMAIL
YIJI_API_URL            = https://order.yiji-app.com
GEMINI_MODEL
SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_FROM
WEBHOOK_TOLERANCE_SEC
OTEL_EXPORTER_OTLP_ENDPOINT   (optional telemetry)
# Directus S3 storage (add these):
STORAGE_LOCATIONS=s3
STORAGE_S3_DRIVER=s3   STORAGE_S3_BUCKET=yiji-directus-uploads
STORAGE_S3_REGION=<region>   (use an IAM task role instead of static keys)
```

### → Build-time only (baked into the frontend bundles — Phase 9)

```
VITE_DIRECTUS_URL       = https://api.<domain>
VITE_SOCKET_URL         = https://gw.<domain>
VITE_AI_GATEWAY_URL     = https://<ai-gateway public route or api path>
VITE_JOB_PRODUCER_URL   = (workers job endpoint, if exposed)
```

### → Deploy tooling

```
REGISTRY   IMAGE_TAG    (used by docker-compose.prod.yml / CI image tags)
```

---

## 8. Per-service task configuration (summary)

| Service        | Image                        | Port        | Needs (env)                                                                                                       |
| -------------- | ---------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| directus       | `directus/directus:11`       | 8055        | DB*\*, REDIS_URL, DIRECTUS_KEY/SECRET, DIRECTUS_ADMIN*_, STORAGE*S3*_, CORS_ORIGIN, DIRECTUS_PUBLIC_URL           |
| socket-gateway | `<ecr>/socket-gateway`       | 8080 + 8081 | REDIS_URL, DIRECTUS_URL/INTERNAL_URL, YIJI_JWT_SECRET, YIJI_WEBHOOK_SECRET, SVC_GATEWAY_TOKEN, WIDGET_CORS_ORIGIN |
| ai-gateway     | `<ecr>/ai-gateway`           | 8085        | DIRECTUS_INTERNAL_URL, YIJI_API_URL, YIJI_API_KEY, GEMINI_API_KEY, GEMINI_MODEL, SVC_AI_TOKEN                     |
| workers        | `<ecr>/workers`              | 8090        | DB*\*/DIRECTUS_INTERNAL_URL, REDIS_URL, AI_GATEWAY_URL, SVC_WORKERS_TOKEN, SMTP*\*                                |
| agent-portal   | `<ecr>/agent-portal` (nginx) | 80          | (build-time VITE\_\* only)                                                                                        |
| admin-portal   | `<ecr>/admin-portal` (nginx) | 80          | (build-time VITE\_\* only)                                                                                        |
| bootstrap      | `<ecr>/directus-bootstrap`   | —           | DB\_\*, DIRECTUS_INTERNAL_URL, admin creds (RunTask once)                                                         |

---

## 9. GitHub-connected options (optional, mostly-UI CI/CD)

- **Frontends → AWS Amplify Hosting** (native GitHub CI/CD, includes CloudFront):
  connect `AFCO-sources/Yiji-CRM`, one Amplify app per SPA (monorepo):
  - base dir `apps/agent-portal`, build `pnpm --filter @yiji/agent-portal build`,
    output `apps/agent-portal/dist`; set `VITE_*` env vars in the Amplify console.
  - repeat for `admin-portal`, `chat-widget`. Auto-builds on every push. This
    replaces Phases 6/9/10 for the frontends.
- **Backend → ECS fed by GitHub:** either add ECR-push + `aws ecs update-service
--force-new-deployment` steps to `.github/workflows/deploy.yml`, **or** create a
  **CodePipeline** (Source: GitHub → Build: CodeBuild → Deploy: ECS) in the console.
- **App Runner** is a simpler container option but does not fit `workers`
  (background consumer) or WebSockets well — prefer ECS for a coherent backend.

---

## 10. IAM permissions to verify / request

Ask your AWS admin to confirm these (the ⚠️ items are the common blockers):

| Area                  | Actions                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| VPC (use, not create) | `ec2:Describe*`; `ec2:CreateSecurityGroup`, `Authorize*Ingress`                   |
| ⚠️ IAM roles          | create (or be given) `ecsTaskExecutionRole` + a task role, **and `iam:PassRole`** |
| ECS                   | `ecs:*` (cluster, task defs, services, RunTask)                                   |
| ECR                   | `ecr:*`                                                                           |
| RDS                   | `rds:CreateDBInstance`, `rds:Describe*`                                           |
| ElastiCache           | `elasticache:Create*`, `Describe*`                                                |
| S3                    | `s3:CreateBucket`, `PutObject`, `GetObject`, bucket policy                        |
| Secrets Manager       | `secretsmanager:CreateSecret`, `GetSecretValue`                                   |
| Load balancer         | `elasticloadbalancing:*`                                                          |
| Logs                  | `logs:CreateLogGroup/Stream`, `PutLogEvents`                                      |
| ACM / Route 53        | `acm:RequestCertificate`; Route 53 record changes (often admin-controlled)        |
| Amplify (if used)     | `amplify:*`                                                                       |

**Check first:** open the VPC console — if a **default VPC** exists, you avoid
VPC-creation permissions entirely.

---

## 11. Verification checklist

1. `https://api.<domain>/server/health` returns `ok` (Directus + RDS reachable).
2. Log into `https://admin.<domain>` as the Directus admin.
3. Log into `https://app.<domain>` as an agent → the ticket/inbox + compensation
   queues load (RDS read path works).
4. Open the widget (`https://widget.<domain>/?phone=%2B9665…&customer_id=…`) →
   send a message → it appears in the agent inbox in **real time** (socket-gateway
   - ElastiCache path works).
5. Order panel populates for a **real Yiji customer** (ai-gateway → Yiji reachable;
   it is empty for synthetic customers).
6. Run a compensation action button → status changes persist (Directus flows work).

---

## 12. Rough cost estimate

4 small Fargate services + `db.t4g.*` RDS + `cache.t4g.*` ElastiCache + 1 ALB +
CloudFront/S3 ≈ **$120–250 / month** depending on sizing and Multi-AZ.

---

## 13. One-line dependency order

**Domains/ACM → VPC (default ok) → ECR/images → Secrets → RDS → ElastiCache → S3
→ ECS + ALB → bootstrap → build+upload frontends → CloudFront → DNS → verify.**
