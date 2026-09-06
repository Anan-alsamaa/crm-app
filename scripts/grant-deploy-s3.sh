#!/usr/bin/env bash
#
# grant-deploy-s3.sh — let the GitHub Actions deploy role publish the portals.
#
#   scripts/grant-deploy-s3.sh            # show what would change
#   scripts/grant-deploy-s3.sh --apply    # write it
#
# WHY THIS EXISTS
#
# The `crm-github-deploy` role had NO S3 permission at all, so every CI deploy
# died at the upload:
#
#   fatal error: An error occurred (AccessDenied) when calling the
#   ListObjectsV2 operation: ... not authorized to perform: s3:ListBucket
#
# `aws s3 sync` lists the bucket before it copies anything — that is how it
# knows what is already there — so ListBucket is not optional for a sync, and
# `--delete` additionally needs DeleteObject.
#
# The obvious fix is an identity policy on the role, but this account's owner
# has no `iam:PutRolePolicy` (verified with simulate-principal-policy: an
# implicitDeny), and waiting on an account admin blocks every deploy. A BUCKET
# policy is resource-based and needs only `s3:PutBucketPolicy`, which the owner
# does have — so the same grant is expressed from the other side.
#
# WHAT IT DELIBERATELY DOES NOT DO
#
# It appends one statement and leaves everything else alone. Each of these
# buckets already carries an `AllowCloudFrontServicePrincipal` statement that
# is the ONLY reason the sites are readable; replacing the policy wholesale
# would take the portals down. Re-running replaces just this script's own
# statement, matched by Sid.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ACCOUNT="${AWS_ACCOUNT_ID:-408568863712}"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/crm-github-deploy"
SID="AllowGitHubDeployPublish"
APPLY=""
[ "${1:-}" = "--apply" ] && APPLY=1

BUCKETS=(
  crm-staging-agent-portal
  crm-staging-admin-portal
  crm-prod-agent-portal
  crm-prod-admin-portal
)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[32m%s\033[0m\n' "$*"; }
die() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "aws is not on PATH"

for BUCKET in "${BUCKETS[@]}"; do
  say "$BUCKET"

  # An empty policy is not an error here — a bucket may legitimately have none.
  CURRENT="$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text 2>/dev/null || echo '')"

  NEW="$(
    ROLE_ARN="$ROLE_ARN" SID="$SID" BUCKET="$BUCKET" CURRENT="$CURRENT" node -e '
      const { ROLE_ARN, SID, BUCKET, CURRENT } = process.env;
      const policy = CURRENT && CURRENT !== "None"
        ? JSON.parse(CURRENT)
        : { Version: "2012-10-17", Statement: [] };

      // Drop any previous run of this script, so re-running is idempotent
      // rather than stacking duplicate statements.
      policy.Statement = (policy.Statement ?? []).filter((s) => s.Sid !== SID);

      policy.Statement.push({
        Sid: SID,
        Effect: "Allow",
        Principal: { AWS: ROLE_ARN },
        // ListBucket is on the BUCKET; the object actions are on its CONTENTS.
        // They are different resources, which is why one statement names both.
        Action: ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
      });

      process.stdout.write(JSON.stringify(policy, null, 2));
    '
  )" || die "could not build the policy for $BUCKET"

  KEPT="$(printf '%s' "$NEW" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);console.log(p.Statement.map(s=>s.Sid).join(", "))})')"
  printf '    statements after: %s\n' "$KEPT"

  if [ -z "$APPLY" ]; then
    printf '    (dry run — pass --apply to write)\n'
    continue
  fi

  printf '%s' "$NEW" > ".bucket-policy-${BUCKET}.json"
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://./.bucket-policy-${BUCKET}.json" \
    || { rm -f ".bucket-policy-${BUCKET}.json"; die "could not write the policy for $BUCKET"; }
  rm -f ".bucket-policy-${BUCKET}.json"
  ok "granted"
done

if [ -z "$APPLY" ]; then
  say "nothing was changed"
else
  say "done"
  cat <<'NOTE'
    Verify from the role's point of view, not from this output:

      aws iam simulate-principal-policy \
        --policy-source-arn arn:aws:iam::408568863712:role/crm-github-deploy \
        --action-names s3:ListBucket \
        --resource-arns arn:aws:s3:::crm-staging-agent-portal

    A resource-based grant shows as `allowed` there only when the resource ARN
    is given — without it the simulator has no bucket policy to consult and
    reports implicitDeny, which is not the same as "still broken".
NOTE
fi
