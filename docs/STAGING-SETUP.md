# Staging setup — status and what is verified

_2026-08-31. Staging reuses the EXISTING RDS and ElastiCache (cost decision by
the account owner). Everything below was **tested**, not assumed._

---

## Verified working

| thing                | result                                                               |
| -------------------- | -------------------------------------------------------------------- |
| RDS DNS              | `18.223.62.15` — **public** address                                  |
| RDS TCP 5432         | reachable from a laptop outside the VPC                              |
| RDS credentials      | ✅ connect as `yijicrm` to `afcoCrm`                                 |
| Postgres version     | **15.17** (local dev and the compose file use **16** — see below)    |
| Redis DNS            | `192.168.120.118` — **private**                                      |
| Redis cluster detect | ✅ `clustercfg.` recognised → `ioredis.Cluster`, prefix `{yiji}`     |
| `.env.staging`       | written, gitignored, fresh secrets, `YIJI_COUPON_DELIVERY=off`       |
| **SMTP**             | ✅ **Office 365 verified** — `smtp.office365.com:587`, auth accepted |
| **`crm_staging` DB** | ✅ created on RDS and loaded from local: 66 tables, full audit trail |

> **Corporate DNS lies about both hosts.** The office resolver appends
> `.althawaqh.com` and answers `10.1.10.22` for anything. Resolve through a
> public server (`Resolve-DnsName -Server 8.8.8.8`) or every reachability test
> is meaningless.

---

## ⚠ THE BLOCKER — Redis and the app would be in different VPCs

```
Redis 192.168.120.118 → 192.168.0.0/16 → vpc-08ea7d710f4596303  (eksctl-afco-cluster)
EC2   172.31.38.178   → 172.31.0.0/16  → vpc-0036e2aa4b398c155  (default)
```

**Separate VPCs do not route to each other.** The RDS endpoint is public so the
database works from anywhere, but Redis is private: an instance launched in the
default VPC **cannot reach it at all**. Confirmed by connecting — the client
returns `Failed to refresh slots cache`.

Three ways out, cheapest first:

1. **Launch the staging EC2 into `vpc-08ea7d710f4596303`** (the EKS VPC), the
   same one Redis lives in. Free. Needs a subnet in that VPC and Redis's
   security group to allow 6379 from the new instance.
2. **Run `redis:7-alpine` on the staging box** — already in
   `docker-compose.prod.yml`. Free, works today, no permission needed. Redis
   holds only transient job state, so staging diverging from prod here costs
   much less than diverging on the database.
3. VPC peering. More moving parts than this deployment justifies.

**Recommendation: (1) if the subnet and security-group change are easy, else
(2).** Do not spend money here.

---

## The database migration — done

`crm_staging` was created on the shared RDS instance and loaded from the local
Docker database on 2026-08-31. Verified by count, not by exit code:

|                                    | local           | crm_staging         |
| ---------------------------------- | --------------- | ------------------- |
| tables (app / total)               | 37 / 66         | **37 / 66**         |
| tickets / conversations / messages | 68 / 232 / 460  | **68 / 232 / 460**  |
| contacts / stores / brands         | 277 / 122 / 4   | **277 / 122 / 4**   |
| coupon_approvals / sla_policies    | 26 / 2          | **26 / 2**          |
| directus_revisions / activity      | 100506 / 154943 | **100506 / 154943** |
| foreign keys / indexes             | —               | **104 / 127**       |

The full audit trail came across: field history and "last modified by" are
derived from `directus_revisions`, so dropping it would have blanked both.

> ### ⚠ The version trap, and the only route that works
>
> **Local is Postgres 17.10; RDS is 15.17.** `pg_dump` **refuses to read a
> server newer than itself**, so the v15 client cannot dump the v17 database at
> all — it aborts with "server version mismatch". And a v17 custom-format dump
> cannot be restored into v15.
>
> The route that worked:
>
> 1. dump **plain SQL** with the **v17** `pg_dump` (matching the source server);
> 2. delete the single line `SET transaction_timeout = 0;` — a **PG17-only**
>    setting absent in 15, which would abort the restore on line 13;
> 3. restore with a **v15** `psql`.
>
> Plain SQL is the key: a custom-format dump is a binary archive and cannot be
> edited to remove that line.
>
> **Three Postgres versions are in play** and they should converge:
> `docker-compose.override.yml` pins **17**, `docker-compose.yml` and
> `docker-compose.prod.yml` pin **16**, RDS is **15**. Staging matching
> production matters more than either matching local.

## Schema drift on `afcoCrm`

The database is **empty of business data** — 0 tickets, 0 conversations, 0 SLA
policies, last activity `2026-08-09`. It is the leftover from the 2026-08-06 ECS
attempt, so nothing of value is at risk.

But its schema is **three weeks stale**. Missing, all created by the bootstrap:

```
coupon_requests   coupon_approvals   stores
store_master      routing_events     quick_replies
```

So the bootstrap must run before staging is usable. Run it **before** the
migrations in `GO-LIVE-READINESS.md` §4b — those assume the tables exist.

> **Postgres 15.17, not 16.** Local dev and `docker-compose.prod.yml` both use 16. Nothing in this app is known to depend on a 16-only feature, but it is a
> real staging/production difference and it is the kind of thing that surfaces
> as a migration failing only in one place. Worth knowing before blaming the
> code.

---

## Still blocked

| item               | waiting on                                                |
| ------------------ | --------------------------------------------------------- |
| the five hostnames | DNS for `crm.anan.sa`                                     |
| EC2 key pair       | `ec2:CreateKeyPair`                                       |
| Elastic IP         | `ec2:AllocateAddress` — without it the IP moves on reboot |
| `YIJI_TENANT_ID`   | copy from `.env.prod`                                     |
| `GEMINI_API_KEY`   | copy from `.env.prod`                                     |

> **SES is no longer needed.** The tenant has an Office 365 mailbox
> (`Yiji@anan.sa`) whose SMTP credentials were verified on 2026-08-31 —
> `smtp.office365.com:587`, STARTTLS, auth accepted. That removes **two items**
> from the access request (SES access and the IAM-created SMTP credential) and
> removes the domain-verification + sandbox-approval wait entirely, which was
> the longest external dependency in the plan.

---

## Deliberate staging/production differences

| setting                | staging                | production  |
| ---------------------- | ---------------------- | ----------- |
| `YIJI_COUPON_DELIVERY` | **`off`, permanently** | `on`        |
| `SMTP_FROM`            | tagged `(staging)`     | plain       |
| instance size          | `t3.small`             | `t3.medium` |
| secrets                | separate               | separate    |

> `YIJI_COUPON_DELIVERY=off` is the one difference that MUST exist. Staging
> shares the real Yiji tenant, so `on` there hands real customers real money for
> test data. Everything else in the path still runs — coupons are created,
> approved, queued and swept — only the final push is suppressed, and it logs
> `disabled`.
