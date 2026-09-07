# What the CRM costs to host: AWS today vs GCP

**Written 2026-09-07.** Resource counts come from the live account. Traffic
comes from 30 days of CloudWatch metrics. Unit prices are published list
prices, cited below — the AWS Pricing API is denied to this user, so they were
taken from the vendors' pricing pages rather than queried.

> **This is a build-up, not an invoice.** `ce:GetCostAndUsage` is denied for
> `e.habibi@anan.sa`, so the real bill could not be read. Every figure here is
> derived from what is deployed × a published rate, and the arithmetic is shown
> so it can be checked. Ask for `ce:GetCostAndUsage` if this needs to be
> tracked rather than estimated once.

---

## What is actually deployed

Measured, not assumed:

| Service                            | Environment | vCPU | Memory | Running |
| ---------------------------------- | ----------- | ---: | -----: | ------: |
| directus                           | staging     |  0.5 |   1 GB |       1 |
| socket-gateway                     | staging     | 0.25 | 0.5 GB |       1 |
| ai-gateway                         | staging     | 0.25 | 0.5 GB |       1 |
| workers                            | staging     |  0.5 |   1 GB |       1 |
| directus                           | production  |  0.5 |   1 GB |       1 |
| _(3 prod services still to start)_ |             |  1.0 |   2 GB |       0 |

**Totals when production is complete: 3.0 vCPU and 6 GB across 8 tasks.**

**Traffic, 30 days across all 8 CloudFront distributions: 28,796 requests and
114 MB.** That is small enough that CDN and egress are rounding errors — a fact
that matters, because it removes the usual "GCP egress is cheaper" argument
in either direction.

---

## Unit prices used

| Rate                                   | Price            | Source              |
| -------------------------------------- | ---------------- | ------------------- |
| Fargate vCPU-hour                      | $0.04048         | AWS Fargate pricing |
| Fargate GB-hour                        | $0.004445        | AWS Fargate pricing |
| Cloud Run vCPU-second (always-on)      | $0.000024        | Cloud Run pricing   |
| Cloud Run GiB-second (always-on)       | $0.0000025       | Cloud Run pricing   |
| RDS db.t3.medium PostgreSQL, single-AZ | ~$0.072/hr       | AWS RDS pricing     |
| Cloud SQL per vCPU / per GB, monthly   | ~$30.11 / ~$5.11 | Cloud SQL pricing   |
| ALB                                    | $0.0225/hr + LCU | AWS ELB pricing     |

730 hours per month throughout.

---

## AWS today

### Compute

```
3.0 vCPU × $0.04048 × 730 h  =  $88.65
6.0 GB   × $0.004445 × 730 h =  $19.47
                                -------
Fargate, 8 tasks                $108.12
```

### Everything else the CRM owns

| Item                                         |   Monthly |
| -------------------------------------------- | --------: |
| Fargate (above)                              |   $108.12 |
| ALB `crm-alb` — $0.0225 × 730, + ~1 LCU      |    $22.34 |
| CloudFront — 28.8k requests, 114 MB          |     $0.02 |
| S3 — 5 MB across 8 buckets                   |     $0.01 |
| CloudWatch Logs — 5 groups, 30-day retention |       ~$3 |
| **CRM's own resources**                      | **~$134** |

### What the CRM does not pay for

The database, Redis and NAT gateways belong to other teams' workloads and
would keep running if the CRM disappeared:

| Shared resource                          | Full cost | CRM's use          |
| ---------------------------------------- | --------: | ------------------ |
| RDS `test-yiji` (also hosts 5 other DBs) |      ~$53 | one database on it |
| ElastiCache Redis cluster                |      ~$50 | one key prefix     |
| 2 NAT gateways                           |      ~$65 | shared egress      |

**AWS marginal cost today: ~$134/month.** If the CRM were charged a fair share
of the shared infrastructure — say a fifth of the database, a third of Redis
and a fifth of the NAT — add roughly $40, for **~$174**.

---

## GCP, like for like

Cloud Run billed instance-based, because Directus, the socket gateway and the
workers must stay warm — a chat gateway that cold-starts is a chat that drops.

### Compute

```
Production, 4 services always on:
  1.5 vCPU × $0.000024 × 2,628,000 s  =  $94.61
  3.0 GiB  × $0.0000025 × 2,628,000 s =  $19.71
                                          ------
                                          $114.32

Staging, 4 services, scale-to-zero, ~8 h/day active:
  roughly one third of the above         ~$38
```

Cloud Run's scale-to-zero is a real saving on staging. It cannot help
production, and Cloud Run's per-second rate is **higher** than Fargate's for
an always-on workload — $114 against $108 for the same production shape.

### Full GCP build

| Item                                           |     Monthly |
| ---------------------------------------------- | ----------: |
| Cloud Run — production, always on              |     $114.32 |
| Cloud Run — staging, scale-to-zero             |        ~$38 |
| **Cloud SQL PostgreSQL, 2 vCPU / 4 GB, HA**    | **$161.32** |
| Memorystore Redis, 1 GB Basic                  |        ~$35 |
| Cloud Load Balancing — forwarding rule + rules |        ~$22 |
| Cloud Storage + Cloud CDN, at this traffic     |         ~$1 |
| Cloud Logging, beyond the free 50 GiB          |         ~$2 |
| **Total**                                      |   **~$373** |

Cloud SQL at 2 vCPU / 4 GB: `(2 × $30.11) + (4 × $5.11) = $80.66`, doubled for
HA = **$161.32**. A one-year committed-use discount takes it to roughly $130;
the table below uses the undiscounted figure, because the AWS side is
undiscounted too and mixing the two would flatter GCP.

---

## Side by side

|                      | AWS today | AWS, fair share |       GCP |
| -------------------- | --------: | --------------: | --------: |
| Compute              |      $108 |            $108 |      $152 |
| Database             |  borrowed |            ~$11 |      $161 |
| Redis                |  borrowed |            ~$17 |       $35 |
| Load balancing       |       $22 |             $22 |       $22 |
| NAT / egress         |  borrowed |            ~$13 |        $0 |
| CDN + storage + logs |       ~$3 |             ~$3 |       ~$3 |
| **Monthly**          | **~$134** |       **~$174** | **~$373** |

**GCP costs about $239/month more than today, or $199 more than a fully costed
AWS — roughly $2,400–2,900 per year.**

Two things drive that gap, and one of them is counter-intuitive:

- **The database, ~$150 of it.** On AWS the CRM uses an instance that already
  exists for other workloads; on GCP it must buy its own, with HA.
- **Cloud Run is not cheaper than Fargate for always-on work.** For the same
  3.0 vCPU and 6 GB running continuously, Cloud Run is **$228.64 against
  Fargate's $108.12 — 111% more**. Scale-to-zero saves real money on staging,
  which is idle most of the day, and nothing at all on production, which must
  stay warm. The GCP compute figure above is only competitive _because_ staging
  scales to zero.

---

## What the numbers do not capture

**The rebuild.** ECS task definitions, host-based ALB routing separating
staging from production, 8 CloudFront distributions, S3 bucket policies,
service discovery, a bootstrap job, and 9 app roles carrying 563 permissions —
all rewritten for Cloud Run, Cloud SQL and GCP load balancing. Two to four
weeks, during which nothing else ships and everything proven on staging
becomes unproven.

**Yiji stays on AWS.** The CRM reads Yiji's order and customer APIs, and
Yiji's production runs in this account and VPC. Moving to GCP puts a public
internet hop between the CRM and the system it exists to serve. If those APIs
are ever restricted to internal traffic, that is a request to the same manager,
with more urgency.

**Two clouds to operate.** Two IAM models, two consoles, two billing
relationships.

**The argument on the other side: access.** The permission queue on this
account is not hypothetical. As of today the ECR grant has been requested
twice and still is not applied, the production database is waiting on
approval, and billing is invisible. A GCP project where you hold Owner has
none of that. If access delays cost even two days a month, $219 buys them
back — that is the honest case for moving, and it is about control, not cost.

---

## Recommendation

**A separate AWS account** answers the access problem without paying the GCP
premium or rebuilding anything: full admin, clean IAM, no shared database,
every existing script still valid, and the CRM stays on the same network as
Yiji. It is usually an easier approval than a new cloud, because it changes
nothing about the vendor relationship or the security review.

**Stay on the shared account** only if that separate account is refused and
the current friction is tolerable.

**Move to GCP** if — and only if — the access friction is genuinely blocking
delivery and a separate AWS account has been refused. It is the most expensive
option in both money and weeks, and it moves the CRM away from Yiji.

---

## Sources

- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [Amazon RDS pricing](https://aws.amazon.com/rds/pricing/)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Cloud SQL pricing](https://cloud.google.com/sql/pricing)
- [db.t3.medium rates, Vantage](https://instances.vantage.sh/aws/rds/db.t3.medium)
- [Cloud SQL machine-type pricing, Bytebase](https://www.bytebase.com/dbcost/cloudsql-pricing/)
