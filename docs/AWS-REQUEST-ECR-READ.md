# One IAM change, so CI can deploy

**Status:** blocking the five image builds. Everything else in the pipeline is
green — the portal publish was a second, separate denial and it is now FIXED
(see "The S3 half, already solved" below).
**Raised:** 2026-09-05, after the first CI deploy on `main` failed.
**Still open:** 2026-09-06.

---

## The ask (paste this)

> The GitHub Actions deploy role `crm-github-deploy` in account `408568863712`
> can push image layers to ECR but cannot read them back, so every
> `docker push` is denied. Please add three actions to the existing inline
> policy `crm-github-deploy-policy`, in the statement `ECRPushCRMImages`:
>
> - `ecr:BatchGetImage`
> - `ecr:GetDownloadUrlForLayer`
> - `ecr:DescribeImages`
>
> The resource scope does not change — it stays
> `arn:aws:ecr:us-east-2:408568863712:repository/crm/*`, exactly the
> repositories the role already writes to. Nothing outside ECR is touched.
>
> I cannot apply this myself: my user has no `iam:PutRolePolicy`.

---

## Two ways to grant it, and which to prefer

The question came up as "would allowing `iam:PutRolePolicy` fix this?" — it
would, and it is the bigger of the two grants. Both routes end with the same
three actions on the same role; they differ in who holds the power afterwards.

|                                      | **A — add the three ECR actions** (asked for above) | **B — grant me `iam:PutRolePolicy`**                                                              |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Who does the work                    | The admin, once                                     | Me, and thereafter anyone with my credential                                                      |
| What it permits                      | Reading images in `crm/*`, nothing else             | Rewriting the inline policy of a role — including granting that role anything the admin can grant |
| Blast radius if the credential leaks | One ECR namespace                                   | Privilege escalation: the role can be handed new permissions, then assumed                        |
| Reversible                           | Remove three strings                                | Requires noticing the policy changed                                                              |

**A is the one to ask for.** B is a standing power to re-permission a role,
held to solve a problem that is a one-line policy edit; that trade is only
worth making if these grants are expected to change often, and they are not —
this policy has changed twice since the account was set up.

If the admin would rather scope B than refuse it, `iam:PutRolePolicy`
restricted by `Resource` to `arn:aws:iam::408568863712:role/crm-github-deploy`
is far narrower than the unscoped version, though it still permits granting
that one role anything.

### Why "I already have that access" is true and changes nothing

The owner's user DOES hold all three actions — verified, and it is the reason
`scripts/deploy-service.sh` deploys happily from a laptop while CI cannot.

    e.habibi@anan.sa            ecr:BatchGetImage  allowed
    role/crm-github-deploy      ecr:BatchGetImage  implicitDeny

Two identities. GitHub Actions never uses the owner's credential: it assumes
`crm-github-deploy` through OIDC, and a role has only what its own policy
grants. So the ask is not for new access to the account — it is to give the
CI role the access the owner already has, narrowed to `crm/*`.

### What this does NOT fix

- **Anything outside the five image builds.** The quality gate, the plan and
  the portal upload all pass today; the ONLY remaining failure is
  `ecr:BatchGetImage`, 15 occurrences from one cause.

### A SECOND, unrelated ask worth sending in the same message

`sns:Subscribe`, for the owner's user.

The alarm topic `arn:aws:sns:us-east-2:408568863712:crm-alerts` exists and
seven staging alarms publish to it — task count per service, Directus CPU and
memory, log volume. Verified 2026-09-06: **the topic has zero subscribers**
and `sns:Subscribe` is denied, so every one of those alarms fires into
nothing. Nobody is told when a service dies.

It has no bearing on the failing pipeline — the builds fail on ECR alone —
but it is the difference between monitoring and decoration, and it is one
grant to the same admin.

## The S3 half, already solved — do not ask for it

The same run failed TWICE for two unrelated reasons, and only one of them needs
an admin. The portal upload died on:

```
fatal error: An error occurred (AccessDenied) when calling the ListObjectsV2
operation: ... not authorized to perform: s3:ListBucket on resource:
"arn:aws:s3:::crm-staging-agent-portal"
```

`aws s3 sync` lists a bucket before copying, so `ListBucket` is not optional,
and `--delete` also needs `DeleteObject`. The role had no S3 permission at all.

That one did NOT need an IAM change: a **bucket** policy is resource-based and
needs only `s3:PutBucketPolicy`, which the owner already has. Applied to the
four portal buckets by `scripts/grant-deploy-s3.sh` on 2026-09-06, appending a
single `AllowGitHubDeployPublish` statement and leaving each bucket's existing
`AllowCloudFrontServicePrincipal` statement untouched. Verified: the
"Build & upload portals" job now succeeds and really uploads.

One caveat carried over from that fix: a resource-based grant is invisible to
`aws iam simulate-principal-policy`, which evaluates identity policies only. It
will keep reporting `implicitDeny` for these buckets even though the deploy
demonstrably works — read the bucket policy itself, or the job log, not the
simulator.

**The same trick does NOT rescue ECR.** ECR repositories do take resource
policies, but the owner has no `ecr:SetRepositoryPolicy` either (checked
2026-09-06: `implicitDeny`), so there is no way around the ask below. It is the
one remaining thing standing between this pipeline and a fully automated
deploy.

## Why a push needs read permissions

Not obvious, and worth stating so the request does not look like scope creep:
**`docker push` reads before it writes.** It asks the registry which layers
already exist so it can upload only the new ones, and that read is
`ecr:BatchGetImage`. A role with only the write half can authenticate, start an
upload, and then fail:

```
denied: User: arn:aws:sts::408568863712:assumed-role/crm-github-deploy/GitHubActions
is not authorized to perform: ecr:BatchGetImage on resource:
arn:aws:ecr:us-east-2:408568863712:repository/crm/directus
```

`ecr:DescribeImages` is for the deploy's own safety check: it confirms an image
really is in ECR before a task definition is registered against it. Without
that check, ECS accepts a task definition pointing at an image that was never
pushed, and the rollout sits `IN_PROGRESS` with zero running tasks and no error
anywhere — which is exactly what happened on 2026-09-05 when an ECR login
expired mid-deploy.

## What is affected

|                     |                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Broken**          | Automated deploys from GitHub Actions — every image build fails at push.                                                         |
| **Working**         | Manual deploys via `scripts/deploy-service.sh`, which run under a user that has the permissions. Staging is current and healthy. |
| **Risk of waiting** | Every deploy stays a manual step on one person's laptop, which is the thing the pipeline exists to remove.                       |

## Verifying it worked

```bash
# Should list the eight actions, including the three new ones:
aws iam get-role-policy --role-name crm-github-deploy \
  --policy-name crm-github-deploy-policy \
  --query 'PolicyDocument.Statement[?Sid==`ECRPushCRMImages`].Action[]' --output text
```

Then re-run the failed workflow; the build jobs should push and the deploy jobs
should follow.

---

## Verification, 2026-09-07: not applied to the principals asked for, and no longer needed from an admin

Checked three ways, all agreeing: the inline policy `crm-github-deploy-policy`
on the role still lists push-only ECR actions; `simulate-principal-policy`
against every `crm/*` repository ARN returns implicit deny for the three read
actions and for `sns:Subscribe` on the `crm-alerts` topic ARN; and the Deploy
run for `c396c34` failed all five image jobs with
`not authorized to perform: ecr:BatchGetImage … because no identity-based
policy allows the action`.

What the check also found: the owner's own IAM user, `r.obeid@anan.sa`, holds
**AdministratorAccess** (and the `DevOps` group's SystemAdministrator). That
user can apply both grants itself. `scripts/grant-deploy-access.sh` does
exactly that, idempotently, dry-run by default:

```bash
AWS_PROFILE=<r.obeid profile> ALERT_EMAIL=<address> scripts/grant-deploy-access.sh          # plan
AWS_PROFILE=<r.obeid profile> ALERT_EMAIL=<address> scripts/grant-deploy-access.sh --apply  # write
```

It ends by simulating the role and listing the topic's subscriptions, so the
result is read back rather than assumed. Afterwards: re-run the failed Deploy
run (`gh run rerun <id> --failed`) and click the SNS confirmation email.
