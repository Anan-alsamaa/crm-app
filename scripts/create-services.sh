#!/usr/bin/env bash
#
# create-services.sh — create the ECS services for one environment, with
# auto-scaling and the deployment settings that make a release invisible.
#
#   scripts/create-services.sh staging
#   scripts/create-services.sh prod
#
# Run AFTER: the cluster exists, task definitions are registered, and the IAM
# roles exist. Re-running updates the existing services rather than failing.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in staging|prod) ;; *) echo "usage: $0 <staging|prod>" >&2; exit 2;; esac

REGION="${AWS_REGION:-us-east-2}"
CLUSTER="crm-${ENV_NAME}"
# 2c and 2b ONLY. `SubnetPrivateUSEAST2A` is misnamed: its default route is the
# internet gateway, not the NAT, so a task there would sit directly on the
# internet. Verified by route table, not by the Name tag.
SUBNETS="subnet-0413e537a84480b74,subnet-0a6a3341b8796580a"
# TWO security groups, deliberately:
#   sg-06ca4c19fa44b2dc3  crm-ecs-tasks — ours; outbound only for now
#   sg-0cd4698b2c26e93c0  the VPC default — ElastiCache grants access by
#     MEMBERSHIP of this group (its rule allows all traffic from itself), so a
#     task must BE a member to reach Redis. Attaching it is how you get Redis
#     access without editing a group shared with production Redis and MSK.
SG="${CRM_TASK_SG:-sg-06ca4c19fa44b2dc3,sg-0cd4698b2c26e93c0}"

# ── Per-service desired counts ────────────────────────────────────────────
#
# Production runs TWO of the services whose interruption is visible to a user,
# and ONE of the two that degrade gracefully:
#
#   directus        2 — everything depends on it; if it stops, nothing works
#   socket-gateway  2 — live chat; customers would see the disconnection
#   ai-gateway      1 — the AI panel errors, agents keep working on tickets
#   workers         1 — jobs queue and are picked up on restart; the 60s
#                       DB-driven sweeps (SWEEP_INTERVAL_MS) mean nothing is lost
#
# Why two and not "one plus a standby": ECS has no standby. Replacing a failed
# task takes 3-4 minutes (detect ~60s, start ~30s, Directus migrations 60-120s,
# health checks ~30s) and the same applies to every deploy. A warm standby IS a
# second running task, billed identically — so the real choice is two tasks or
# minutes of downtime per incident and per release.
#
# Staging runs one of everything: a brief interruption there costs nothing.
if [ "$ENV_NAME" = "prod" ]; then
  # workers runs NINE queues (SLA deadlines, coupon delivery, notifications,
  # reports, imports, automation, routing, ai, customer-push) at concurrency 5.
  # Starving it does not fail loudly — jobs queue, so SLA warnings fire late and
  # coupons sit undelivered. It gets the same 2-4 treatment as the front door.
  declare -A DESIRED=([directus]=2 [socket-gateway]=2 [ai-gateway]=1 [workers]=2)
  # ai-gateway caps at 2, not 3: the AI assistant is an add-on, and agents work
  # normally without it. workers keeps 3 — it drives nine queues (SLA deadlines,
  # coupon delivery, email, reports, imports), and starving it does not fail
  # loudly, it just makes everything late.
  declare -A MAXCOUNT=([directus]=4 [socket-gateway]=4 [ai-gateway]=2 [workers]=4)
else
  # Staging does NOT autoscale: min == max. Its job is to prove the code works,
  # not to absorb load, and nobody is waiting on it. Scaling headroom here is
  # capacity that would never be used, so the ceiling is set to the resting
  # count and staging's cost is a fixed, predictable number.
  declare -A DESIRED=([directus]=1 [socket-gateway]=1 [ai-gateway]=1 [workers]=1)
  declare -A MAXCOUNT=([directus]=1 [socket-gateway]=1 [ai-gateway]=1 [workers]=1)
fi

# Sweep interval, per environment. These DB-driven sweeps are what let the
# system survive losing Redis — the queue holds only scheduling, so the next
# sweep refills it — which is why production keeps them at 60s.
#
# Staging is exercised occasionally by one person. 43,200 sweeps a day there
# versus 8,640 buys nothing, and it is not free: log volume is charged per GB
# and is NOT capped by the scaling limits, and every sweep queries a database
# instance shared with other teams.
SWEEP_MS=$([ "$ENV_NAME" = "prod" ] && echo 60000 || echo 300000)
echo "  sweep interval: ${SWEEP_MS}ms"

echo "==> Services for $CLUSTER"

for svc in directus socket-gateway ai-gateway workers; do
  echo "--- $svc (desired ${DESIRED[$svc]}, max ${MAXCOUNT[$svc]})"

  # `workers` takes no inbound traffic, so it gets no load-balancer target and
  # no health-check grace period.
  EXTRA=()
  if [ "$svc" != "workers" ]; then
    # 180s: Directus runs migrations on first boot. Without the grace period the
    # load balancer health-checks too early, marks the task unhealthy, and ECS
    # kills it in a loop — a deploy that never converges.
    EXTRA+=(--health-check-grace-period-seconds 180)
  fi

  aws ecs create-service --region "$REGION" \
    --cluster "$CLUSTER" --service-name "$svc" \
    --task-definition "crm-${ENV_NAME}-${svc}" \
    --desired-count "${DESIRED[$svc]}" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100,deploymentCircuitBreaker={enable=true,rollback=true}" \
    "${EXTRA[@]}" >/dev/null 2>&1 && echo "    created" || echo "    exists (use update-service to change it)"

  # ── Auto-scaling ──────────────────────────────────────────────────────
  # Target tracking: ECS adds tasks while average CPU is above 70% and removes
  # them when it falls, so you pay for extra capacity only while it is doing
  # something. The scale-IN cooldown is deliberately longer than scale-OUT —
  # adding capacity late hurts users, removing it early causes flapping.
  aws application-autoscaling register-scalable-target --region "$REGION" \
    --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
    --resource-id "service/${CLUSTER}/${svc}" \
    --min-capacity "${DESIRED[$svc]}" --max-capacity "${MAXCOUNT[$svc]}" >/dev/null

  aws application-autoscaling put-scaling-policy --region "$REGION" \
    --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
    --resource-id "service/${CLUSTER}/${svc}" \
    --policy-name "${svc}-cpu70" --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration \
      '{"TargetValue":70.0,"PredefinedMetricSpecification":{"PredefinedMetricType":"ECSServiceAverageCPUUtilization"},"ScaleOutCooldown":60,"ScaleInCooldown":300}' \
    >/dev/null && echo "    autoscaling ${DESIRED[$svc]}-${MAXCOUNT[$svc]} on CPU 70%"
done

echo
echo "==> Deployment settings applied to every service:"
echo "    minimumHealthyPercent=100  — the old tasks keep serving until the new"
echo "                                 ones are healthy, so a release is invisible"
echo "    maximumPercent=200         — room to start replacements alongside"
echo "    circuit breaker + rollback — a failing deploy reverts itself instead of"
echo "                                 leaving the service down"
echo
echo "Next: scripts/create-alarms.sh $ENV_NAME <sns-topic-arn>"
echo "      (and enable Container Insights, or the task-count alarms stay silent)"
