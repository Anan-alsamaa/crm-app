#!/usr/bin/env bash
#
# create-listener-rules.sh — put the ALB path routing in place for one
# environment. Idempotent: re-running replaces each rule's conditions rather
# than failing or duplicating.
#
#   scripts/create-listener-rules.sh staging
#   scripts/create-listener-rules.sh prod
#
# WHY THIS EXISTS
#
# The staging routing was built entirely by hand, one `aws elbv2 create-rule` at
# a time, and nothing recorded it. Production would then have been stood up with
# whichever rules somebody remembered — and a MISSING rule does not fail loudly:
# the path falls through to the default target and is answered by DIRECTUS,
# which returns a confident `404 ROUTE_NOT_FOUND`.
#
# That is exactly how the eight AI endpoints were dead on staging for the whole
# life of the deployment. Every AI feature 404'd, and because the 404 came from
# the wrong service, the ai-gateway's own log showed nothing wrong at all.
#
# THE FIVE-VALUE LIMIT
#
# An ALB allows 5 condition values per rule (`condition-values-per-alb-rule`).
# Two path-pattern conditions on ONE rule are ANDed, not ORed, so splitting a
# long list across conditions matches NOTHING. Eight paths therefore need two
# rules, which is why the AI endpoints are 21 and 22 rather than one rule.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in staging|prod) ;; *) echo "usage: $0 <staging|prod>" >&2; exit 2;; esac

REGION="${AWS_REGION:-us-east-2}"
ALB_NAME="${ALB_NAME:-crm-alb}"
# Target group names are capped at 32 chars, hence `stg`/`prd` rather than the
# full environment name.
SHORT=$([ "$ENV_NAME" = "prod" ] && echo prd || echo stg)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

LB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" --names "$ALB_NAME" \
           --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null) \
  || die "load balancer $ALB_NAME not found"

# CloudFront terminates TLS, so the ALB listens on plain HTTP behind it.
LISTENER=$(aws elbv2 describe-listeners --region "$REGION" --load-balancer-arn "$LB_ARN" \
             --query 'Listeners[?Port==`80`].ListenerArn' --output text)
[ -n "$LISTENER" ] || die "no port-80 listener on $ALB_NAME"

tg() {
  aws elbv2 describe-target-groups --region "$REGION" --names "crm-${SHORT}-$1" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null \
    || die "target group crm-${SHORT}-$1 does not exist - create the services first"
}

TG_SOCKETIO=$(tg socketio)   # Socket.IO transport, port 8080, stickiness ON
TG_SOCKET=$(tg socket)       # the same service's REST app, port 8081
TG_AI=$(tg ai)

# Replace the rule at $1 with conditions $2 -> target $3, creating it if absent.
# Idempotent so this can be re-run after adding a path without hand-editing AWS.
upsert() {
  local priority="$1" paths="$2" target="$3"
  local existing
  existing=$(aws elbv2 describe-rules --region "$REGION" --listener-arn "$LISTENER" \
               --query "Rules[?Priority=='${priority}'].RuleArn" --output text)
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    aws elbv2 modify-rule --region "$REGION" --rule-arn "$existing" \
      --conditions "Field=path-pattern,PathPatternConfig={Values=[${paths}]}" \
      --actions "Type=forward,TargetGroupArn=${target}" >/dev/null
    echo "  [$priority] updated: $paths"
  else
    aws elbv2 create-rule --region "$REGION" --listener-arn "$LISTENER" \
      --priority "$priority" \
      --conditions "Field=path-pattern,PathPatternConfig={Values=[${paths}]}" \
      --actions "Type=forward,TargetGroupArn=${target}" >/dev/null
    echo "  [$priority] created: $paths"
  fi
}

say "listener rules for $ENV_NAME"

# 10 — Socket.IO transport. BOTH patterns are needed: an ALB wildcard requires
# at least one character after it, so `/socket.io/*` alone does NOT match the
# handshake URL, which is exactly `/socket.io/` plus a query string.
upsert 10 '/socket.io,/socket.io/*' "$TG_SOCKETIO"

# 11 — the socket-gateway's REST surface, which listens on PORT+1.
upsert 11 '/webhooks/*,/jobs/*,/walk-in/*,/teams/*,/debug/*' "$TG_SOCKET"

# 20 — the AI gateway's commerce proxy and its admin endpoints.
upsert 20 '/commerce/*,/admin/config,/admin/usage' "$TG_AI"

# 21 + 22 — the eight AI_ENDPOINTS (packages/shared-types/src/ai.ts), split
# because of the five-value limit above. Keep these in sync with that file: a
# new endpoint added there and NOT added here is answered by Directus with a
# 404 that names the path, which reads like a client bug.
upsert 21 '/summarize-conversation,/suggest-reply,/analyze-sentiment,/detect-intent,/extract-entities' "$TG_AI"
upsert 22 '/semantic-search,/score-lead,/help-assistant' "$TG_AI"

# Everything else falls through to the default action (Directus).

say "current routing"
aws elbv2 describe-rules --region "$REGION" --listener-arn "$LISTENER" \
  --query "Rules[].{P:Priority,Paths:join(' ',Conditions[?Field=='path-pattern'].Values[]|[]),TG:Actions[0].TargetGroupArn}" \
  --output text | sed -E 's#arn:aws:elasticloadbalancing:[^ ]*targetgroup/([^/]+)/[0-9a-f]+#\1#'

cat <<'NOTE'

Verify from outside, not from this output: a rule can exist and still not match.

  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/suggest-reply" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'

A 400 means the AI gateway received it and rejected the empty body - correct.
A 404 mentioning ROUTE_NOT_FOUND means Directus answered, so the rule is wrong.
NOTE
