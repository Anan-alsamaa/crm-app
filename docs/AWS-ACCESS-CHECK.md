# Checking what AWS access you already have

> ## RESULT, 2026-08-31 — checked in the console
>
> Account **`408568863712`** (matches the existing ECS runbook), region
> **us-east-2**, IAM user `e.habibi@anan.sa`.
>
> | service         | result                                                                              |
> | --------------- | ----------------------------------------------------------------------------------- |
> | SES             | ❌ `ses:GetAccount`, `ses:ListRecommendations` denied                               |
> | RDS             | ❌ `rds:DescribeDBInstances`, `DescribeDBClusters`, `DescribeDBSubnetGroups` denied |
> | IAM create user | ❌ `iam:CreateUser` denied — so the SMTP credential cannot be self-served           |
> | ElastiCache     | ✅ list works (0 caches)                                                            |
> | EC2             | ✅ list works — **6 instances already running**, incl. 2× t3.2xlarge and a bastion  |
> | VPC             | ✅ visible                                                                          |
>
> Every denial read _"because no identity-based policy allows..."_ — the user has
> **no policy at all** for those services, not a narrowed one. So this is an
> additive ask, not an argument about scope.
>
> **Note the account is already in use by someone else** (those 6 instances).
> Worth knowing whose before adding to it, and it is why a tag-scoped policy is
> the easier thing for an owner to approve.
>
> The exact ask is in [`AWS-ACCESS-REQUEST.md`](./AWS-ACCESS-REQUEST.md).

_Run these before asking for anything. Each one is read-only or trivially
reversible — nothing here creates a billable resource that you cannot delete in
the same minute._

Two routes. **The console route needs no setup** and is the fastest way to find
out. The CLI route is better if you will be doing this repeatedly.

---

## The principle

The only reliable test of a permission is **trying the thing**. AWS hides what
you cannot do rather than greying it out with an explanation, so "I can see the
RDS page" proves nothing — the create button may still fail at the last step.

So each check below goes as far as the **final confirmation screen** and stops.
Where a check must actually create something, it says so, and says how to undo it.

---

## Route A — the console (no setup)

Set the region to **US East (Ohio) `us-east-2`** in the top-right first. Then
work down the list. For each: if you get **"You don't have permission"** or the
button is missing, note it — that is a real gap.

### A0. Which account are you even in?

Click your name (top-right). Note the **account ID**.

> **This is the most important check on the page.** The plan assumes
> `408568863712`, from the existing ECS runbook in this repo. If yours differs,
> the existing RDS and Redis are not there and the plan needs adjusting — tell
> me the number rather than proceeding.

### A1. SES

1. Search **SES** → open it.
2. Left nav → **Identities** → **Create identity**.
3. Choose **Domain**, type anything (`test.example.com`), **do not submit** —
   just confirm the form loads and the Create button is enabled.
4. Left nav → **Account dashboard**. Can you see either "Request production
   access" or a note that you already have it?
5. Left nav → **SMTP settings**. Can you see **Create SMTP credentials**?

> Step 5 is the one most likely to fail even when 1–4 pass, because creating
> SMTP credentials creates an **IAM user**, which is often restricted
> separately. If only that fails, your manager can create it and hand you the
> two values — you do not need the permission yourself.

### A2. RDS

1. Search **RDS** → **Databases** → **Create database**.
2. Select **Standard create**, **PostgreSQL**.
3. Scroll to the bottom. Is **Create database** enabled?
4. **Do not click it.** Leave the page.

Also check: **Subnet groups** in the left nav. If the list is empty, a DB subnet
group has to be created before RDS will launch — a small extra step worth
knowing about now.

### A3. ElastiCache

1. Search **ElastiCache** → **Redis OSS caches** → **Create**.
2. Confirm the form loads and **Create** is enabled at the bottom.
3. Leave without creating.

### A4. EC2

1. Search **EC2** → **Instances** → **Launch instances**.
2. Confirm the launch wizard loads.
3. Left nav → **Key pairs** → is **Create key pair** available?
4. Left nav → **Security groups** → is **Create security group** available?
5. Leave without launching.

### A5. VPC (read is enough)

**VPC** → **Your VPCs**. Do you see at least one? Note its ID and whether it has
subnets in at least two availability zones — RDS wants two.

### A6. Billing (optional but useful)

**Billing and Cost Management** → **Bills**. If you can see this, you can check
your own spend rather than asking. Frequently restricted; not a blocker.

---

## Route B — the CLI (better if you will repeat this)

### Install

```powershell
winget install Amazon.AWSCLI
```

Then restart the terminal and confirm:

```powershell
aws --version
```

### Configure

You need an **access key**. If you already have console access, create one:
**IAM → Users → your user → Security credentials → Create access key** (choose
"Command Line Interface").

```powershell
aws configure
# AWS Access Key ID:     AKIA...
# AWS Secret Access Key: ...
# Default region name:   us-east-2
# Default output format: json
```

### The checks

Each command below either returns data (**you have the permission**) or an
`AccessDenied` error (**you do not**). None of them creates anything.

```powershell
# WHO AM I — and critically, WHICH ACCOUNT
aws sts get-caller-identity

# SES — can I list identities?
aws ses list-identities --region us-east-2
aws sesv2 get-account --region us-east-2          # shows sandbox status too

# RDS — can I list instances and subnet groups?
aws rds describe-db-instances --region us-east-2
aws rds describe-db-subnet-groups --region us-east-2

# ElastiCache
aws elasticache describe-cache-clusters --region us-east-2

# EC2 + VPC
aws ec2 describe-instances --region us-east-2 --max-items 5
aws ec2 describe-vpcs --region us-east-2
aws ec2 describe-subnets --region us-east-2 --query "Subnets[].{AZ:AvailabilityZone,Id:SubnetId}"
aws ec2 describe-key-pairs --region us-east-2
aws ec2 describe-security-groups --region us-east-2 --max-items 5
```

### The honest limitation

**`describe-*` succeeding proves you can READ, not that you can CREATE.** IAM
policies routinely grant one and not the other. To test creation for real, the
only certain way is to create something and delete it:

```powershell
# Cheapest possible real test: a security group. Free, and deletable instantly.
aws ec2 create-security-group --region us-east-2 `
  --group-name access-test-delete-me `
  --description "temporary permission check" `
  --vpc-id <your-vpc-id>

# then immediately:
aws ec2 delete-security-group --region us-east-2 --group-name access-test-delete-me
```

A security group costs nothing and leaves no trace once deleted, which makes it
the safest thing to test _create_ permission with. **Do not** do the equivalent
with RDS or EC2 — those bill from the moment they launch, and an RDS instance
with deletion protection on is awkward to remove.

For RDS specifically, the console's "is the Create button enabled at the final
step" check (A2) is the better test.

---

## Recording what you find

Fill this in and send it back — it tells me exactly what to ask for and what to
work around:

```
Account ID:            ____________  (matches 408568863712? yes / no)
Region visible:        us-east-2 ?   yes / no

SES  create identity        yes / no
SES  request prod access    yes / no
SES  create SMTP creds      yes / no
RDS  create database        yes / no
RDS  subnet group exists    yes / no
ElastiCache create          yes / no
EC2  launch instance        yes / no
EC2  create key pair        yes / no
EC2  create security group  yes / no
VPC  exists (id: ______ )   yes / no
VPC  subnets in 2+ AZs      yes / no
Billing visible             yes / no

DNS for anan.sa — who owns it?  ____________________
```

---

## If some of it is missing

Not all gaps are equal:

| gap                | severity                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| **RDS create**     | Blocking. Nothing else matters without a database.                                         |
| **EC2 launch**     | Blocking. Nowhere to run the app.                                                          |
| **SES identity**   | Blocking for email; the rest of the app runs without it.                                   |
| **SES SMTP creds** | Workaround: your manager creates the IAM user and hands you the two values.                |
| **VPC create**     | Only if no VPC exists. Ask for the VPC to be created _for_ you rather than the permission. |
| **Billing**        | Not blocking. Nice for self-service.                                                       |

**A partial "yes" is still worth acting on.** RDS, Redis and EC2 need no DNS and
no SES, so if those three work you can build the whole stack and add email last.
