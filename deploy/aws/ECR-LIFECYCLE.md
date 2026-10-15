# ECR image clean-up rule

Approved by the owner on 2026-10-12. It needs an AWS user allowed to run `ecr:PutLifecyclePolicy`; the CRM operator account is not.

**What it does**, per repository, in priority order:

1. Keeps the newest 30 release images (`v*`). Matching this rule first also protects them from rule 2.
2. Keeps the newest 10 staging builds (`sha-*`). `main` is always the newest build, so it is always kept.
3. Deletes untagged leftovers after 7 days.

**Simulated on 2026-10-12** against all five repositories: every image running on prod (then `v1.50.4`; releases are now tagged `v1.1.N`, still matched by `v*`) and staging (`main`) is kept. About 305 old images (~24 GB) would be removed.

**Apply** (run once; AWS then applies it daily):

```bash
for r in crm/directus crm/socket-gateway crm/ai-gateway crm/workers crm/bootstrap; do
  aws ecr put-lifecycle-policy --region us-east-2 --repository-name "$r" \
    --lifecycle-policy-text file://deploy/aws/ecr-lifecycle-policy.json
done
```

**Undo:** `aws ecr delete-lifecycle-policy --region us-east-2 --repository-name <repo>`. Images already removed cannot be restored.
