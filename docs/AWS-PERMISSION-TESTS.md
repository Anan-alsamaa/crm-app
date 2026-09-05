# AWS permission tests — run these before committing to the architecture

_2026-09-02. Region **us-east-2 (Ohio)** for every test. Account `408568863712`,
user `e.habibi@anan.sa`._

The ECS Fargate architecture depends on IAM that has **never been tested on this
account**. This file is the test. Run it in the console — there is no AWS CLI
here because `iam:CreateAccessKey` was denied.

> **A rendered Create button is not permission.** SES, RDS and ElastiCache all
> drew the orange button directly above their own denial banner. Only submitting
> the form tells you anything. Screenshot every denial: the exact action name is
> what makes the access request forwardable instead of arguable.

**Set the region to us-east-2 before every test.** Drifting region is the most
common failure — the VPC dropdown silently offers a different default VPC and
nothing matches.

---

## How to record a result

Fill the **Result** column as you go: `PASS`, or `DENIED: <exact action name>`
copied from the red banner. The action name is the whole point — "it didn't
work" cannot be forwarded to anyone.

---

## Test 1 — ECR (blocks: the whole registry decision)

**ECR → Repositories → Create repository**

- Name: `crm-perm-test`
- Everything else default → **Create**

| Check                  | Result |
| ---------------------- | ------ |
| `ecr:CreateRepository` |        |

Then, on that repository → **Delete**:

| Check                  | Result |
| ---------------------- | ------ |
| `ecr:DeleteRepository` |        |

> If create passes but delete is denied, that matches the account's known
> "create but not destroy" pattern. **Not a blocker** — it just means Rabih
> cleans up. Note it and move on.

---

## Test 2 — IAM roles (blocks: logs, S3 uploads, OIDC — the critical one)

This is the test that decides the architecture. All three ECS failures from the
2026-08-06 attempt were missing roles, not Fargate limitations.

**IAM → Roles → Create role**

- Trusted entity: **AWS service** → **Elastic Container Service** →
  **Elastic Container Service Task**
- Permissions: attach `AmazonECSTaskExecutionRolePolicy`
- Name: `crm-perm-test-role` → **Create role**

| Check                  | Result |
| ---------------------- | ------ |
| `iam:CreateRole`       |        |
| `iam:AttachRolePolicy` |        |

Then delete it:

| Check            | Result |
| ---------------- | ------ |
| `iam:DeleteRole` |        |

> **If `iam:CreateRole` is DENIED, ECS Fargate is off the table** until Rabih
> grants it. Without an execution role there are no CloudWatch logs; without a
> task role there is no S3, so uploads are ephemeral. That is exactly the broken
> deployment we are retiring. Fall back to EC2 + Compose, which needs almost no
> IAM and already has a tested runbook and deploy script.

---

## Test 3 — IAM OIDC provider (blocks: keyless CI/CD)

**IAM → Identity providers → Add provider**

- Type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com` → **Add provider**

| Check                             | Result |
| --------------------------------- | ------ |
| `iam:CreateOpenIDConnectProvider` |        |

> Denied means GitHub Actions cannot authenticate to AWS without stored access
> keys — and `iam:CreateAccessKey` is **already denied**, so there would be no
> keys to store either. CI could still push to ECR only if Rabih supplies
> credentials. **This one is worth asking for specifically**; it is the
> difference between keyless CI and no CI.

---

## Test 4 — ECS cluster + task definition

**ECS → Clusters → Create cluster**

- Name `crm-perm-test`, **AWS Fargate** only → **Create**

| Check               | Result |
| ------------------- | ------ |
| `ecs:CreateCluster` |        |

**ECS → Task definitions → Create new task definition with JSON.** Paste a
minimal definition — note it references the role from Test 2, so if that was
denied, **omit both role lines** and record that separately:

```json
{
  "family": "crm-perm-test",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::408568863712:role/crm-perm-test-role",
  "containerDefinitions": [
    {
      "name": "probe",
      "image": "public.ecr.aws/docker/library/busybox:latest",
      "essential": true,
      "command": ["true"]
    }
  ]
}
```

| Check                                           | Result |
| ----------------------------------------------- | ------ |
| `ecs:RegisterTaskDefinition`                    |        |
| `iam:PassRole` (only tested if the role exists) |        |

Then delete the cluster:

| Check               | Result |
| ------------------- | ------ |
| `ecs:DeleteCluster` |        |

> **`iam:PassRole` is a separate permission from `iam:CreateRole`.** You can be
> allowed to create a role and still be refused permission to hand it to a task,
> which fails at RegisterTaskDefinition or at service creation. Test both.

---

## Test 5 — S3 (blocks: durable uploads, portal hosting)

Bucket `yiji-crm-directus-uploads` already exists, so creation may already be
proven — but test a **new** one, since the architecture needs buckets for the
two portals too.

**S3 → Create bucket** — name `crm-perm-test-<random>`, us-east-2 → **Create**

| Check                                  | Result |
| -------------------------------------- | ------ |
| `s3:CreateBucket`                      |        |
| `s3:PutObject` (upload any small file) |        |
| `s3:DeleteBucket`                      |        |

---

## Test 6 — CloudFront + ACM (blocks: portal hosting, TLS)

**CloudFront → Create distribution** — origin: any S3 bucket, defaults →
**Create**. This takes a few minutes to deploy; the permission answer is
immediate.

| Check                           | Result |
| ------------------------------- | ------ |
| `cloudfront:CreateDistribution` |        |

**ACM → Request certificate** — public certificate for a domain you control
(e.g. `*.staging.crm.anan.sa`) → **Request**. It will sit in _Pending
validation_; that is fine, it proves the permission.

| Check                    | Result |
| ------------------------ | ------ |
| `acm:RequestCertificate` |        |

> ACM certificates are **free** and a pending one costs nothing. Delete it after.

---

## Test 7 — ALB (already partly proven)

An ALB was created on 2026-08-06 (`yiji-crm-alb`), so
`elasticloadbalancing:CreateLoadBalancer` is **known to work**. What is not
known is deletion — and it matters, because the retirement plan requires it.

Do **not** create another ALB to test this (it bills immediately). Instead try
deleting the existing one **only when staging is live** — that is step 4 of the
retirement list.

| Check                                     | Result               |
| ----------------------------------------- | -------------------- |
| `elasticloadbalancing:DeleteLoadBalancer` | (test at retirement) |

---

## Test 8 — SSM Parameter Store (blocks: secrets out of task definitions)

**Systems Manager → Parameter Store → Create parameter**

- Name `/crm/perm-test`, type **SecureString**, value `test` → **Create**

| Check                 | Result |
| --------------------- | ------ |
| `ssm:PutParameter`    |        |
| `ssm:DeleteParameter` |        |

> Without this, secrets sit as **plaintext environment variables** in the task
> definition, where every revision keeps a copy forever and anyone with ECS read
> access can see them. That is what the 2026-08-06 deployment had to do. It is
> tolerable for staging, **not** for production with real customer data.

---

## Test 9 — RDS (known denied; re-test in case it changed)

**RDS → Databases**. If the list is empty or errors, RDS is still denied.

| Check                     | Result |
| ------------------------- | ------ |
| `rds:DescribeDBInstances` |        |

> Production needs **its own** RDS instance — sharing an instance with other
> teams' databases means inheriting their load, maintenance windows and blast
> radius. If RDS stays denied, Rabih must create the production instance.
> Staging is unaffected: `crm_staging` already exists and works.

---

## Reading the results

| Outcome                   | What it means                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests 1, 2, 4, 5 all PASS | **Build the Fargate architecture.** Everything else is a detail.                                                                                                                                                |
| Test 2 DENIED             | **Stop. Fall back to EC2 + Compose.** No roles means no logs and ephemeral uploads — the broken deployment again. The EC2 runbook and `scripts/deploy-staging.sh` are already written and the preflight passes. |
| Test 3 DENIED             | Fargate still fine; CI cannot deploy keylessly. Ask specifically for the OIDC provider.                                                                                                                         |
| Test 8 DENIED             | Fargate still fine; secrets live as plaintext in task definitions. Acceptable for staging, ask for it before production.                                                                                        |
| Test 1 DENIED             | Stay on GHCR. It works today and the pipeline already exists.                                                                                                                                                   |

**Send me the filled-in table and I will build whichever architecture the results
actually support** — not the one we hoped for.

---

## Cleanup

Delete everything created here: the ECR repo, the IAM role, the OIDC provider,
the ECS cluster, the S3 bucket, the CloudFront distribution, the ACM cert, the
SSM parameter. All are free or near-free, but leaving them makes the next
person's inventory lie.

If a delete is denied, note it — it is more evidence for the same "create but
not destroy" pattern, and it belongs in the ask alongside the still-running
`crm-access-test` instance (`i-074d05fe8afa6dfe5`).
