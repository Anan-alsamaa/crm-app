# AWS access request — send this to your manager

_Written 2026-08-31, after testing every permission in the console. Nothing here
is assumed: each ❌ below is a denial we actually triggered and screenshotted._

---

## The message (paste this)

> Hi — I'm deploying the Sara CRM to AWS (a staging and a production
> environment) in account **408568863712**, region **us-east-2**.
>
> I tested my current access in the console rather than guessing, and I can do
> some of it already: I can create security groups and launch EC2 instances, and
> I can see the VPC and its subnets. Five things are blocked. Each one below is
> an actual "You are not authorized" error I hit, with the exact action name
> AWS reported — screenshots attached.
>
> | #   | I need to                                           | AWS action denied                                                                        | Why the deployment needs it                                                                                                                                                                                                                                                                                                                                            |
> | --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 1   | Create an RDS PostgreSQL database                   | all RDS denied — even `rds:DescribeDBInstances`, so I can't reach the create form at all | The CRM's database. Nothing runs without it.                                                                                                                                                                                                                                                                                                                           |
> | 2   | Create an ElastiCache Redis node                    | `elasticache:CreateServerlessCache` (both serverless and node-based creation fail)       | The background job queue — coupons, notifications, scheduled reports.                                                                                                                                                                                                                                                                                                  |
> | 3   | Set up SES for outgoing email                       | all SES denied — even `ses:GetAccount`                                                   | Password resets and scheduled reports. The app refuses to start in production without a mail server configured.                                                                                                                                                                                                                                                        |
> | 4   | An SMTP credential for SES                          | `iam:CreateUser`                                                                         | SES needs an IAM user to issue SMTP credentials. **You can create this and just send me the two values — I don't need the IAM permission itself.**                                                                                                                                                                                                                     |
> | 5   | Create an EC2 key pair, and terminate EC2 instances | `ec2:CreateKeyPair`, `ec2:TerminateInstances`                                            | The key pair is the SSH credential for the two new instances — without one I can't log in to install or run anything. The five existing key pairs belong to other systems (bastion, the EKS nodegroups) and their private keys aren't retrievable from AWS, so they can't be reused. Terminate is so I can clean up instances I create rather than leave them billing. |
>
> **Simplest way to grant 1–3** is the AWS managed policies
> `AmazonRDSFullAccess`, `AmazonElastiCacheFullAccess` and `AmazonSESFullAccess`.
> If you'd rather scope it tighter, I'm happy with a policy limited to resources
> tagged `Project=crm` — just tell me which you prefer.
>
> **Expected cost is about $75/month for both environments combined**
> (RDS db.t4g.micro ~$13, Redis cache.t4g.micro ~$12, two EC2 instances ~$45,
> SES effectively free). Everything stays in one region and the existing VPC.
>
> **One cleanup item:** while testing I launched a t2.micro named
> `crm-access-test` (`i-074d05fe8afa6dfe5`) and then found I can't terminate it.
> Could you terminate it, or grant me `ec2:TerminateInstances`? It's about $0.30
> a month, so it's tidiness rather than cost.
>
> Separately — and this may be a different team — I need DNS records under
> **`crm.anan.sa`**: five hostnames for the app, plus three CNAMEs that SES
> requires to verify the domain. Delegating the whole `crm.anan.sa` subdomain
> would cover both in one go and can't affect `anan.sa` mail or the website.

---

## Screenshots to attach

You already have four of the five. Attach them in this order — each shows the
exact IAM action name, which is what makes the request actionable rather than
a conversation:

| #   | screenshot                 | shows                                               |
| --- | -------------------------- | --------------------------------------------------- |
| 1   | SES console                | `ses:GetAccount` / `ses:ListRecommendations` denied |
| 2   | RDS console                | `rds:DescribeDBInstances` denied                    |
| 3   | IAM create user            | `iam:CreateUser` denied                             |
| 4   | EC2 → Create key pair      | `ec2:CreateKeyPair` denied                          |
| 5   | EC2 → Instances            | `ec2:TerminateInstances` denied                     |
| 6   | ElastiCache → Create cache | `elasticache:CreateServerlessCache` denied          |

> **Why attach them at all:** a manager approving this has to justify it to
> whoever owns the account. "He hit `rds:DescribeDBInstances` denied" is a fact
> they can forward. "He says he needs RDS" is a request they have to defend.

---

## Two things to check before sending

**1. ~~Reuse an existing key pair?~~ CHECKED — no.**

Five key pairs exist (`bastion`, `afco-node2`, `mac-flutter`, two
`eksctl-afco-nodegroup-*`), all from 2023–2024 and all belonging to other
systems. **AWS stores only the public half** — the `.pem` was downloaded once
at creation and cannot be retrieved, so selecting a row gives you nothing.
Reusing one would also share a single SSH credential between the CRM and
someone else's EKS bastion, and leave your access dependent on a key you can't
rotate. Item 5 stays in the ask.

> **If `ec2:CreateKeyPair` is refused**, the fallback is **SSM Session
> Manager**: shell access with no key pair and no inbound SSH port at all. It
> needs an IAM instance role plus `ssm:StartSession` — a bigger ask on paper,
> but more secure, and some orgs mandate it. Offer it as an alternative rather
> than leading with it.

**2. ~~Retry ElastiCache node-based?~~ CHECKED — it fails too.**

Serverless denied cleanly (`elasticache:CreateServerlessCache`). The
**node-based** form — the one this deployment actually wants — failed with a
generic _"one or more dependent API calls encountered an error"_ and **no action
name**, because that submit bundles several calls and the console reports only
the first failure without identifying it.

**Attach the Serverless screenshot**, since it is the one carrying an action
name, and ask for ElastiCache access broadly rather than naming a single action.

**Also confirmed while there:** the default VPC has subnets in **three
availability zones** (`us-east-2a/2b/2c`, all /20 in `172.31.0.0/16`). RDS
requires two, so that prerequisite is already met — no networking work is
needed before the database.

---

## What you deliberately are NOT asking for

Keeping the list short is what gets it approved. All of these were considered
and are genuinely unnecessary:

| not asking for         | because                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| **ACM / certificates** | Caddy provisions Let's Encrypt certs automatically and renews them.                             |
| **ECR**                | Container images go to GitHub's registry, which CI already pushes to.                           |
| **S3**                 | Directus stores uploads on a local volume.                                                      |
| **Load balancers**     | Caddy on the instance does this. An ALB is ~$18/mo per environment for no benefit at this size. |
| **Secrets Manager**    | Config lives in a root-readable `.env.prod` on each instance.                                   |
| **Route53**            | Only needed if DNS moves to AWS. Records can be added wherever the domain lives today.          |
| **VPC create**         | The existing `vpc-0036e2aa4b398c155` with its 3 subnets is enough.                              |
| **ECS / Fargate**      | The app runs as Docker Compose on EC2. See `AWS-DEPLOYMENT-PLAN.md` §2 for why.                 |

---

## What unblocks what

```
RDS + Redis + EC2 key pair ──▶ build the whole stack, both environments
                               (needs NO DNS, NO SES)

SES policy ──▶ verify domain ──▶ request production access (24-48h)
                    ▲
DNS for crm.anan.sa ┘──▶ the five hostnames ──▶ Caddy TLS on first boot
```

**Items 1, 2 and 5 are the ones that block real work.** SES and DNS have
external latency — SES approval takes a day or two — so they should be started
early, but the stack can be built and tested without them and have email added
last.

**DNS is the long pole and often a different team.** If your manager doesn't own
it, ask them who does in the same message rather than discovering it next week.
