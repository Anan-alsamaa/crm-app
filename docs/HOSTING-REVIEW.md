# Hosting review — health and cost

**Written 2026-09-08.** Every figure measured from the live account on that
date, not estimated. Unit prices are published list prices; the AWS Pricing API
and Cost Explorer are both denied to this user, so the totals are a build-up
from what is deployed rather than a copy of the invoice.

---

## Health: everything is running

| Check                         | Staging | Production |
| ----------------------------- | ------- | ---------- |
| ECS services running          | 4 / 4   | 4 / 4      |
| Target groups healthy         | 4 / 4   | 4 / 4      |
| Public URLs answering         | 5 / 5   | 5 / 5      |
| Unrendered placeholders       | none    | none       |
| Secrets shared with the other | none    | none       |
| Chat, end to end              | passing | **6 / 6**  |

Production's chat was exercised the way a customer will use it: a signed token
in the URL, the panel opening with no phone form, a message written, and the
row confirmed in the database. Nothing was left behind — production still holds
zero contacts and zero conversations.

**No faults found.** The two that existed earlier today are fixed and verified:
the deploy pipeline (six consecutive green runs) and staging's AI gateway,
which had been running with a placeholder Gemini key and answering healthy
while every AI feature was dead.

### What each environment holds

|                                 |     Staging |  Production |
| ------------------------------- | ----------: | ----------: |
| Stores / vendors / SLA policies | 133 / 1 / 2 | 133 / 1 / 2 |
| Teams                           |          83 |           2 |
| Contacts                        |       1,788 |           0 |
| Conversations                   |         232 |           0 |
| Tickets                         |       1,692 |           0 |
| Users                           |          21 |           4 |

Staging's 83 teams are 81 QA rows left by automated runs, deliberately not
copied. Production's four users are the owner and three service accounts — no
staff accounts exist yet.

---

## What is deployed

| Service        | Environment | vCPU | Memory |
| -------------- | ----------- | ---: | -----: |
| directus       | staging     |  0.5 |   1 GB |
| socket-gateway | staging     | 0.25 | 0.5 GB |
| ai-gateway     | staging     | 0.25 | 0.5 GB |
| workers        | staging     |  0.5 |   1 GB |
| directus       | production  |  0.5 |   1 GB |
| socket-gateway | production  | 0.25 | 0.5 GB |
| ai-gateway     | production  | 0.25 | 0.5 GB |
| workers        | production  |  0.5 |   1 GB |

**3.0 vCPU and 6 GB across 8 Fargate tasks.**

Measured usage, 30 days: **32,531 CloudFront requests, 165 MB transferred,
6.4 MB in S3.** The database holds 751 MB across ten databases, of which the
CRM's two are 106 MB; 15 of 81 connections are in use.

At that volume, CDN, storage and egress are rounding errors. Compute is
essentially the whole bill.

---

## The cost

```
Fargate:  3.0 vCPU × $0.04048 × 730 h = $88.65
          6.0 GB   × $0.004445 × 730 h = $19.47
                                        -------
                                         $108.12
```

| Item                                |   Monthly |
| ----------------------------------- | --------: |
| Fargate — 8 tasks                   |   $108.12 |
| ALB `crm-alb` — base + ~1 LCU       |      ~$22 |
| CloudFront — 32.5k requests, 165 MB |     $0.03 |
| S3 — 6.4 MB across 8 buckets        |     $0.01 |
| CloudWatch Logs + 7 alarms          |       ~$4 |
| **CRM's own resources**             | **~$134** |

### What the CRM does not pay for

| Shared resource                      | Full cost | The CRM's use     |
| ------------------------------------ | --------: | ----------------- |
| RDS `test-yiji` (hosts 10 databases) |      ~$53 | 2 of them, 106 MB |
| ElastiCache Redis cluster            |      ~$50 | one key namespace |
| 2 NAT gateways                       |      ~$65 | shared egress     |

These belong to other teams' workloads and would keep running if the CRM
disappeared. Charged a proportional share — a fifth of the database, a third of
Redis, a fifth of the NAT — the CRM's true cost is **~$174/month**.

---

## Where the money actually goes

**Staging costs the same as production.** Four identical always-on tasks,
~$54 each. It is idle almost all the time, so roughly $54/month buys an
environment used for a few hours a week. That is the one obvious saving here,
and it needs no migration: scaling staging to zero outside working hours, or
halving its task sizes, would take ~$25–40/month off the bill.

**The ALB is a fixed $22** whatever the traffic. Both environments share it,
which is already the efficient arrangement.

**Everything else is noise.** The CDN moved 165 MB in a month and cost three
cents. There is no saving to find in storage or transfer until traffic grows by
two orders of magnitude.

---

## Two structural risks, neither urgent

**One database credential reaches every database on the instance.** The CRM
connects as `yijicrm`, and that role can read and write all ten databases,
including other teams' live order data. Separate databases prevent accidents
between them; they do not prevent this, because the isolation is per-user and
there is one user. The dedicated RDS instance already requested solves it.

**Production has no redundancy.** One task per service, so an ECS restart is a
brief outage. Fine before launch, and worth revisiting when real customers
depend on it: a second Directus task would cost ~$27/month.

---

## Recommendation

The cost is proportionate and the architecture is sound. Two things worth
doing, in order:

1. **Scale staging down out of hours.** ~$25–40/month for no loss, and no
   migration.
2. **Move production to its own database instance** when it arrives — for the
   shared-credential risk, not for performance. Capacity is not close to a
   limit: 15 of 81 connections, 751 MB of storage.

A move to GCP was costed separately on 2026-09-07 at ~$373/month — nearly three
times the current marginal cost, most of it a database this account currently
borrows. See `HOSTING-COST.md`.
