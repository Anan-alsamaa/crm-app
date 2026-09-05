# One IAM change, so CI can deploy

**Status:** blocking automated deploys. Manual deploys still work.
**Raised:** 2026-09-05, after the first CI deploy on `main` failed.

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
