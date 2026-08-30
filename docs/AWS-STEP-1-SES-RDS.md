# AWS step 1 — SES and RDS

_The first two things to build, because both have external latency: SES approval
takes days, RDS provisioning takes ~15 minutes. Everything else waits on these._

Region: **`us-east-2` (Ohio)** — the account already lives there. Set it in the
console top-right before every step; drifting region is the single most common
failure, because the VPC dropdown silently offers a different default and
nothing matches.

---

## Part A — SES (email)

### A1. Verify a domain, not an address

Console → **Amazon SES** → **Identities** → **Create identity** → **Domain**.

Enter the domain you will send _from_ (e.g. `anan.sa`, or a subdomain like
`mail.anan.sa`). Enable **Easy DKIM**. SES gives you three CNAME records; add
them at your DNS provider. Verification completes in minutes to a few hours.

> Verify a **domain**, not a single address. An address identity only lets you
> send _as_ that one address, and the `SMTP_FROM` in this app is a full
> `"Yiji Support <support@…>"` string.

### A2. Request production access — do this today

Console → **SES** → **Account dashboard** → **Request production access**.

**SES starts in sandbox**: it will only send to addresses you have personally
verified, and caps you at 200/day. That is fine for testing and useless for a
password reset to a real employee. The request form asks what you send and how
you handle bounces — answer honestly:

> Internal CRM for a food-delivery operations team. Transactional only:
> password resets, in-app notification emails to staff, and scheduled
> operational reports to named internal recipients. No marketing. Recipients
> are our own employees. Bounces and complaints are monitored via SES metrics.

Approval is usually 24–48 hours. **It is the long pole in this whole plan.**

### A3. Create SMTP credentials

Console → **SES** → **SMTP settings** → **Create SMTP credentials**.

This creates an IAM user and gives you a username and password **once**. Save
them immediately — they are not retrievable.

These map straight onto the app's env:

```bash
SMTP_HOST=email-smtp.us-east-2.amazonaws.com
SMTP_PORT=587
SMTP_USER=<the SMTP username SES generated>
SMTP_PASSWORD=<the SMTP password SES generated>
SMTP_FROM="Yiji Support <support@yourdomain>"
SMTP_SECURE=false        # 587 uses STARTTLS, which is what `false` means here
```

> `SMTP_SECURE=false` looks alarming and is correct. It means "do not open the
> connection in TLS", because port 587 upgrades to TLS via STARTTLS after
> connecting. `true` is for port 465. Getting this backwards produces a hang,
> not an error.

**Both environments can share one SES identity and one credential.** Email is
the one place staging and production genuinely may differ without risk — though
consider a distinct `SMTP_FROM` (e.g. `Yiji Support (staging)`) so a test email
is obvious in an inbox.

---

## Part B — RDS Postgres, owned by you

This is the "complete control" piece: your instance, your master password, in
your account.

### B1. Create the instance

Console → **RDS** → **Create database**.

| setting                | value                         | why                                                          |
| ---------------------- | ----------------------------- | ------------------------------------------------------------ |
| Engine                 | **PostgreSQL 16**             | matches local dev and `docker-compose.prod.yml`              |
| Template               | Dev/Test                      | Production template forces Multi-AZ, ~2× the cost            |
| DB instance identifier | `crm-db`                      |                                                              |
| Master username        | `crmadmin`                    | **lowercase** — see the trap below                           |
| Master password        | _generate a strong one_       | **this is the control you asked for**                        |
| Instance class         | `db.t4g.micro`                | ~$13/mo; enough for both databases at this scale             |
| Storage                | 20 GB gp3, **autoscaling on** |                                                              |
| Multi-AZ               | No (for now)                  | halves the cost; revisit when uptime matters more than spend |
| Public access          | **No**                        | the EC2 boxes reach it privately                             |
| VPC security group     | create `crm-db-sg`            |                                                              |
| Encryption             | **Enabled**                   | free, and cannot be turned on later                          |
| Backup retention       | **7 days**                    |                                                              |
| Deletion protection    | **Enabled**                   |                                                              |

> ⚠ **Lowercase identifiers, always.** A deployment in this account already
> failed on exactly this: Postgres folds unquoted identifiers to lowercase, the
> connection string does not, and the error you get is an unhelpful
> authentication failure. Lowercase for the master user, the app users and both
> database names.

### B2. Lock the security group

`crm-db-sg` → inbound: **PostgreSQL 5432**, source = the EC2 instances' security
group (not an IP range, and never `0.0.0.0/0`). You will create that group in
step 2; until then, temporarily allow your own IP so you can run B3.

### B3. Create the two databases and two users

Connect once as the master user (from your machine, with your IP temporarily
allowed):

```bash
psql "postgresql://crmadmin:<master-password>@crm-db.xxxx.us-east-2.rds.amazonaws.com:5432/postgres"
```

```sql
CREATE DATABASE crm_prod;
CREATE DATABASE crm_staging;

CREATE USER crm_prod_app    WITH PASSWORD '<generated>';
CREATE USER crm_staging_app WITH PASSWORD '<generated>';

GRANT ALL PRIVILEGES ON DATABASE crm_prod    TO crm_prod_app;
GRANT ALL PRIVILEGES ON DATABASE crm_staging TO crm_staging_app;

-- Directus creates its own tables, so the app user needs the public schema.
\c crm_prod
GRANT ALL ON SCHEMA public TO crm_prod_app;
\c crm_staging
GRANT ALL ON SCHEMA public TO crm_staging_app;
```

**Why two databases on one instance rather than two instances:** identical
engine, version, extensions and TLS behaviour, so a migration that fails in
production fails in staging first — which is the whole point of having staging.
Separate users mean staging cannot read production data. One instance also
halves the bill.

Then in each environment's `.env.prod`:

```bash
# production                        # staging
DB_HOST=crm-db.xxxx.rds.amazonaws.com
DB_PORT=5432
DB_DATABASE=crm_prod                DB_DATABASE=crm_staging
DB_USER=crm_prod_app                DB_USER=crm_staging_app
DB_PASSWORD=<generated>             DB_PASSWORD=<generated>
```

### B4. Migrating off the manager's instance

Only if you want the existing data. Do it **before** production carries anything
real, when a mistake costs nothing:

```bash
# dump from the old instance (scripts/backup-pg.sh does this half already)
pg_dump "postgresql://<old-user>:<old-pass>@<old-host>:5432/<old-db>" \
  --no-owner --no-acl -Fc -f crm-old.dump

# restore into yours
pg_restore -d "postgresql://crm_prod_app:<pass>@crm-db.xxxx.rds.amazonaws.com:5432/crm_prod" \
  --no-owner --no-acl crm-old.dump
```

`--no-owner --no-acl` matters: without them the restore tries to recreate the
_old_ instance's roles and fails partway, leaving a half-populated database.

---

## Part C — ElastiCache Redis

Smaller, and nothing surprising:

Console → **ElastiCache** → **Redis OSS** → **Create**.

| setting               | value                                                |
| --------------------- | ---------------------------------------------------- |
| Design                | **Cluster mode DISABLED**                            |
| Node type             | `cache.t4g.micro` (~$12/mo)                          |
| Replicas              | 0 (for now)                                          |
| Subnet group          | same VPC as RDS and EC2                              |
| Security group        | `crm-redis-sg`, inbound 6379 from the EC2 group only |
| Encryption in transit | Enabled                                              |

> **Cluster mode DISABLED.** BullMQ (the job queue) uses Redis features that
> cluster mode splits across slots, and the earlier ECS attempt in this account
> used a cluster-mode endpoint. Non-clustered is what the app expects.

Two logical databases keep the environments apart on one node:

```bash
REDIS_URL=rediss://crm-redis.xxxx.cache.amazonaws.com:6379/0   # production
REDIS_URL=rediss://crm-redis.xxxx.cache.amazonaws.com:6379/1   # staging
```

`rediss://` (two s) for TLS, matching "encryption in transit".

---

## What you will have at the end

- SES verified, production access **requested** (possibly still pending)
- SMTP credentials saved
- One RDS instance you own, with `crm_prod` and `crm_staging`
- One Redis node, db 0 and db 1
- Security groups written but not yet attached to anything

**Next:** the EC2 instances, `.env.prod` per environment, and the first
`docker compose up`. Nothing there has external latency, so it can follow
immediately.
