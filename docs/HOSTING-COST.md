# What the CRM costs to host, and what GCP would cost

**Written 2026-09-07.** Every AWS figure below is derived from the resources
actually deployed, listed by `aws` and counted — not from a proposal. Prices
are us-east-2 (Ohio) on-demand list, September 2026.

> **The account's real bill could not be read.** `ce:GetCostAndUsage` and every
> other billing action is denied for `e.habibi@anan.sa`. So this is a
> **build-up from the inventory**, not a copy of an invoice. Someone with
> billing access should check it against Cost Explorer before it drives a
> decision. Request `ce:GetCostAndUsage` if that is worth doing regularly.

---

## The distinction that decides the answer

The CRM runs on infrastructure it **shares with other teams**:

| Resource                       | Whose     | Would leaving AWS save it?          |
| ------------------------------ | --------- | ----------------------------------- |
| RDS `test-yiji`                | shared    | **No** — other teams' data on it    |
| ElastiCache Redis `redis-yiji` | shared    | **No** — same                       |
| 2 NAT gateways in the VPC      | shared    | **No** — the EKS cluster needs them |
| ALB `crm-alb`                  | **CRM's** | yes                                 |
| 5 Fargate tasks                | **CRM's** | yes                                 |
| 8 CloudFront distributions     | **CRM's** | yes                                 |
| 8 S3 buckets (~5 MB total)     | **CRM's** | yes                                 |

**So the CRM's marginal cost is far below the cost of running it alone.** The
database and Redis it uses are already paid for by somebody else's workload.
A move to GCP would have to buy those outright — which is the single biggest
term in the comparison, and the one most easily missed.

---

## What the CRM costs on AWS today

Counted from the inventory. Staging runs four services; production currently
runs one (Directus), with three still to start.

| Item                                              | Monthly (USD) |
| ------------------------------------------------- | ------------: |
| Fargate — staging, 4 tasks (1.5 vCPU, 3 GB total) |           ~52 |
| Fargate — production, 4 tasks when complete       |           ~52 |
| ALB `crm-alb`                                     |           ~18 |
| CloudFront, 8 distributions at low traffic        |            ~5 |
| S3 — 5 MB plus requests                           |            <1 |
| CloudWatch Logs — 30-day retention                |            ~5 |
| **CRM marginal total**                            |      **~132** |

Add the shared resources, if the CRM were charged its share rather than
riding along:

| Shared item                                     | Full price | CRM's share if split |
| ----------------------------------------------- | ---------: | -------------------: |
| RDS PostgreSQL (db.t3.medium, Multi-AZ assumed) |       ~120 |                  ~30 |
| ElastiCache Redis (cache.t3.micro cluster)      |        ~50 |                  ~15 |
| NAT gateways ×2                                 |        ~65 |                  ~16 |

**CRM today: roughly 130 USD/month marginal, or ~190 if it paid a quarter
share of the shared infrastructure.**

---

## What the same thing costs on GCP

Like for like, us-central1, September 2026 list prices. GCP has no free
equivalent of the shared database the CRM currently borrows, so this buys one.

| Item                                             | Monthly (USD) |
| ------------------------------------------------ | ------------: |
| Cloud Run — 4 services, staging (scales to zero) |           ~15 |
| Cloud Run — 4 services, production (min 1 each)  |           ~65 |
| **Cloud SQL PostgreSQL (db-custom-1-3840, HA)**  |      **~150** |
| Memorystore Redis (1 GB Basic)                   |           ~35 |
| Cloud Load Balancing                             |           ~22 |
| Cloud CDN + Cloud Storage                        |            ~8 |
| Cloud Logging (beyond free tier)                 |            ~5 |
| **Total**                                        |      **~300** |

Cloud Run's scale-to-zero is a genuine advantage for staging, which sits idle
most of the day: ~15 against Fargate's ~52. It does not help production, which
must stay warm.

---

## Side by side

|                  |  AWS (today) | AWS (paying a share) | GCP (standalone) |
| ---------------- | -----------: | -------------------: | ---------------: |
| Compute          |         ~104 |                 ~104 |              ~80 |
| Database         | 0 (borrowed) |                  ~30 |             ~150 |
| Redis            | 0 (borrowed) |                  ~15 |              ~35 |
| Networking + CDN |          ~23 |                  ~39 |              ~30 |
| Storage + logs   |           ~5 |                   ~5 |               ~5 |
| **Total**        |     **~132** |             **~193** |         **~300** |

**GCP is roughly 2.3× the current AWS bill, and ~1.5× even if the CRM paid a
fair share of the shared infrastructure.** The gap is almost entirely the
database: on AWS the CRM uses an instance that already exists for other
workloads; on GCP it must buy its own.

---

## The costs that are not on the invoice

A migration's price is mostly labour and risk, and those do not appear above.

**Rebuilding what is already working.** The current setup took this project
weeks: ECS task definitions, host-based ALB routing that separates staging
from production, CloudFront distributions, S3 policies, service discovery, a
bootstrap job, and nine app roles carrying 563 permissions. All of it would be
rewritten for Cloud Run, Cloud SQL and GCP load balancing. Realistically two
to four weeks, during which nothing else ships.

**Yiji stays on AWS.** The CRM is not standalone: it reads Yiji's order and
customer APIs, and Yiji's own production runs in this AWS account (its EKS
cluster is in the same VPC). Moving the CRM to GCP puts a public internet hop
between them where there is currently none — slower, and one more thing that
can fail.

**A second cloud to operate.** Two consoles, two IAM models, two billing
relationships, two sets of access requests. The access delays this project has
already hit — ECR permissions, a production database — would be duplicated on
a platform where nobody on the team has standing.

**The one real argument for GCP** is independence: a CRM in its own project
does not compete for permissions with other teams, and no shared database
means no shared blast radius. That is worth something. It is not worth
~170 USD/month plus a month of rebuilding unless the friction is genuinely
blocking delivery.

---

## Recommendation

**Stay on AWS.** The CRM's marginal cost is ~130 USD/month because it shares
infrastructure that is already paid for; GCP would cost ~300 and require
rebuilding everything, while separating the CRM from the Yiji services it
talks to.

Two cheaper ways to get most of what a move would buy:

1. **A dedicated RDS instance** (already requested) removes the shared-database
   risk for ~120 USD/month — a third of a GCP migration, and no rebuild.
2. **A separate AWS account** under the same organisation gives full
   independence and clean IAM, keeps every skill and script, and stays on the
   same network as Yiji. This is what the access friction actually calls for.

Revisit if the CRM's traffic grows enough that Cloud Run's scale-to-zero
outweighs the database, or if Yiji itself moves.
