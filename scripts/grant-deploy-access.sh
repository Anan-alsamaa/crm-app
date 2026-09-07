#!/usr/bin/env bash
# The two grants the CRM deploy still waits on, applied by an ADMINISTRATOR.
#
#   AWS_PROFILE=<admin profile> scripts/grant-deploy-access.sh            # dry run: shows what would change
#   AWS_PROFILE=<admin profile> scripts/grant-deploy-access.sh --apply    # writes
#   ALERT_EMAIL=someone@anan.sa … --apply                                 # also subscribes that address
#
# 1. Role crm-github-deploy gets ECR READ on the crm/* repositories
#    (BatchGetImage, GetDownloadUrlForLayer, DescribeImages). The role can
#    push but not pull, and buildx pulls the previous image for its cache and
#    checks existing layers before pushing, so every image job in deploy.yml
#    fails with "not authorized to perform: ecr:BatchGetImage".
# 2. The crm-alerts SNS topic gets an email subscription. Every CloudWatch
#    alarm (scripts/create-alarms.sh) publishes to it, and it has had ZERO
#    subscribers since it was created, so every alarm has fired into nothing.
#
# Idempotent: a statement or subscription that already exists is left alone.
# Read-only unless --apply is given, so it is safe to run with any profile
# to SEE the plan. Writes need iam:PutRolePolicy and sns:Subscribe, which the
# deploy user (e.habibi) does not hold and r.obeid (AdministratorAccess) does.
set -euo pipefail
export AWS_PAGER=""
REGION="${AWS_REGION:-us-east-2}"
ACCOUNT="${AWS_ACCOUNT_ID:-408568863712}"
ROLE="crm-github-deploy"
POLICY="crm-github-deploy-policy"
TOPIC="arn:aws:sns:${REGION}:${ACCOUNT}:crm-alerts"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1

WHO="$(aws sts get-caller-identity --query Arn --output text)"
echo "acting as: $WHO   ($([ $APPLY = 1 ] && echo APPLY || echo 'dry run'))"

# ── 1. ECR read for the deploy role ─────────────────────────────────────
CUR="$(mktemp)"; NEW="$(mktemp)"; trap 'rm -f "$CUR" "$NEW"' EXIT
aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY" \
  --query PolicyDocument --output json > "$CUR"
node - "$CUR" "$NEW" <<'JS'
const fs = require('node:fs');
const [cur, out] = process.argv.slice(2);
const doc = JSON.parse(fs.readFileSync(cur, 'utf8'));
const want = ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:DescribeImages'];
const have = doc.Statement.find((s) => s.Sid === 'ECRPullCRMImages');
const missing = want.filter((a) => !have || ![].concat(have.Action).includes(a));
if (missing.length === 0) { console.log('role: ECRPullCRMImages already present, nothing to do'); process.exit(0); }
doc.Statement = doc.Statement.filter((s) => s.Sid !== 'ECRPullCRMImages');
doc.Statement.push({ Sid: 'ECRPullCRMImages', Effect: 'Allow', Action: want,
  Resource: `arn:aws:ecr:us-east-2:${process.env.AWS_ACCOUNT_ID || '408568863712'}:repository/crm/*` });
fs.writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`role: will add ECRPullCRMImages (${missing.join(', ')}) on repository/crm/*`);
JS
if [ -s "$NEW" ]; then
  if [ $APPLY = 1 ]; then
    aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY" --policy-document "file://$NEW"
    echo "role: written"
  fi
fi

# ── 2. Someone on the alert topic ───────────────────────────────────────
EMAIL="${ALERT_EMAIL:-}"
if [ -z "$EMAIL" ]; then
  echo "sns: ALERT_EMAIL not set, skipping the subscription"
else
  if aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --region "$REGION" \
       --query "Subscriptions[?Endpoint=='${EMAIL}'].SubscriptionArn" --output text | grep -q .; then
    echo "sns: $EMAIL is already subscribed to crm-alerts"
  else
    echo "sns: will subscribe $EMAIL to crm-alerts (they must click the confirmation email)"
    if [ $APPLY = 1 ]; then
      aws sns subscribe --topic-arn "$TOPIC" --region "$REGION" --protocol email --notification-endpoint "$EMAIL" --output text
      echo "sns: subscription requested; unconfirmed until the email link is clicked"
    fi
  fi
fi

# ── 3. Prove it, do not assume it ───────────────────────────────────────
echo "verify:"
aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::${ACCOUNT}:role/${ROLE}" \
  --action-names ecr:BatchGetImage ecr:GetDownloadUrlForLayer ecr:DescribeImages \
  --resource-arns "arn:aws:ecr:${REGION}:${ACCOUNT}:repository/crm/socket-gateway" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text | sed 's/^/  /'
aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --region "$REGION" \
  --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output text | sed 's/^/  crm-alerts: /'
