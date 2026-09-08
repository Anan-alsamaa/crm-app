#!/usr/bin/env bash
#
# create-alarms.sh — CloudWatch alarms for a deployed CRM environment.
#
#   scripts/create-alarms.sh staging <sns-topic-arn>
#   scripts/create-alarms.sh prod    <sns-topic-arn>
#
# Run AFTER the ECS services exist — an alarm on a service that has never
# reported a datapoint sits in INSUFFICIENT_DATA and tells you nothing.
#
# WHY THESE ALARMS, AND NOT REDIS REDUNDANCY
#
# The queue is not the source of truth. Every important job has a DB-driven
# sweep (SLA reconcile, coupon delivery, inactivity, scheduled reports) that
# re-derives its work from Postgres every SWEEP_INTERVAL_MS. So losing Redis
# costs at most one sweep interval — the queue refills itself.
#
# That recovery has ONE precondition: the workers service must actually be
# running. If it dies quietly, no sweep runs, and the safety net is gone with
# no error anywhere. That has happened in this codebase before: the SLA sweep
# was dead for the entire life of the feature and nothing reported it.
#
# So the money goes here — free alarms on the thing that must not stop —
# rather than on a Redis replica that would shorten a rare outage by minutes.
set -euo pipefail

ENV_NAME="${1:-}"; TOPIC="${2:-}"
case "$ENV_NAME" in staging|prod) ;; *) echo "usage: $0 <staging|prod> <sns-topic-arn>" >&2; exit 2;; esac
[ -n "$TOPIC" ] || { echo "an SNS topic ARN is required — an alarm nobody is told about is decoration" >&2; exit 2; }

REGION="${AWS_REGION:-us-east-2}"
CLUSTER="crm-${ENV_NAME}"
AWS=(aws cloudwatch put-metric-alarm --region "$REGION")

alarm() { # name description metric namespace dims statistic period evals threshold operator
  "${AWS[@]}" \
    --alarm-name "$1" --alarm-description "$2" \
    --metric-name "$3" --namespace "$4" --dimensions $5 \
    --statistic "$6" --period "$7" --evaluation-periods "$8" \
    --threshold "$9" --comparison-operator "${10}" \
    --treat-missing-data "${11:-breaching}" \
    --alarm-actions "$TOPIC" --ok-actions "$TOPIC"
  echo "  created: $1"
}

echo "==> Alarms for $CLUSTER"

# 1. THE IMPORTANT ONE. Workers stopped => no sweeps => the recovery mechanism
#    the whole design rests on is silently gone. `breaching` on missing data is
#    deliberate: no metric at all is exactly the case being guarded against.
alarm "crm-${ENV_NAME}-workers-stopped" \
  "Workers service has no running tasks — background jobs and ALL recovery sweeps have stopped" \
  RunningTaskCount ECS/ContainerInsights \
  "Name=ClusterName,Value=${CLUSTER} Name=ServiceName,Value=workers" \
  Minimum 60 2 1 LessThanThreshold breaching

# 2-4. The three request-serving services. Below 1 task = an outage; the
#      zero-downtime design runs 2 in production, so 1 means one has died.
for svc in directus socket-gateway ai-gateway; do
  alarm "crm-${ENV_NAME}-${svc}-stopped" \
    "${svc} has no running tasks — the service is down" \
    RunningTaskCount ECS/ContainerInsights \
    "Name=ClusterName,Value=${CLUSTER} Name=ServiceName,Value=${svc}" \
    Minimum 60 2 1 LessThanThreshold breaching
done

# 5. Sustained CPU. Not an outage, but the signal that a task size is wrong —
#    which is the open question on Directus (sized from 381 MB observed idle).
alarm "crm-${ENV_NAME}-directus-cpu-high" \
  "Directus CPU above 85% for 15 minutes — likely under-sized" \
  CPUUtilization AWS/ECS \
  "Name=ClusterName,Value=${CLUSTER} Name=ServiceName,Value=directus" \
  Average 300 3 85 GreaterThanThreshold notBreaching

# 6. Memory is the one that kills Directus. An OOM on Fargate presents as a
#    task restarting with no explanation, so catch the approach, not the crash.
alarm "crm-${ENV_NAME}-directus-memory-high" \
  "Directus memory above 85% for 15 minutes — OOM restarts look like random crashes" \
  MemoryUtilization AWS/ECS \
  "Name=ClusterName,Value=${CLUSTER} Name=ServiceName,Value=directus" \
  Average 300 3 85 GreaterThanThreshold notBreaching

# ── 7. Log volume guard ───────────────────────────────────────────────────
# Logs are the one line that is NOT capped by the scaling limits: they are
# charged per GB COLLECTED, and a logging bug produces volume regardless of how
# many copies are running. This project has seen it — a BullMQ lock storm once
# produced 245,000 lines. The alarm fires long before the bill does.
THRESHOLD_GB=${LOG_ALARM_GB:-25}
aws cloudwatch put-metric-alarm --region "$REGION"   --alarm-name "crm-${ENV_NAME}-log-volume-high"   --alarm-description "Log ingestion above ${THRESHOLD_GB}GB this month — check for a logging loop before it reaches the bill"   --metric-name IncomingBytes --namespace AWS/Logs   --statistic Sum --period 86400 --evaluation-periods 1   --threshold $(( THRESHOLD_GB * 1073741824 / 30 ))   --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching   --alarm-actions "$TOPIC"
echo "  created: crm-${ENV_NAME}-log-volume-high (>${THRESHOLD_GB}GB/month pace)"

# 8-11. RUNNING but not SERVING.
#
# Every alarm above watches the task COUNT, which stays at 1 while a container
# answers nothing: it started, so ECS is satisfied and will never replace it.
# That gap is where an outage hides. It is not hypothetical here - the staging
# AI gateway ran for days on a placeholder API key, reporting healthy, with
# every AI feature dead behind it.
#
# The load balancer already knows: it health-checks each target and stops
# sending traffic to one that fails. UnHealthyHostCount turns that into a
# notification.
#
# Target groups are named crm-prd-*/crm-stg-*, which is NOT the cluster name,
# so they are looked up rather than derived. A group that does not exist is
# skipped rather than fatal, so this stays re-runnable mid-build.
TG_PREFIX=$([ "$ENV_NAME" = prod ] && echo crm-prd || echo crm-stg)
LB_ARN=$(aws elbv2 describe-load-balancers --names crm-alb --region "$REGION" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || echo "")

if [ -n "$LB_ARN" ] && [ "$LB_ARN" != None ]; then
  LB_DIM="${LB_ARN##*:loadbalancer/}"
  # "<target-group-suffix>:<service>" - the group name is abbreviated
  # (crm-prd-socket) but the alarm is named for the SERVICE, so it sorts
  # beside its -stopped twin and reads the same in the mail.
  for pair in directus:directus socket:socket-gateway socketio:socketio ai:ai-gateway; do
    tg="${pair%%:*}"; svc="${pair##*:}"
    TG_ARN=$(aws elbv2 describe-target-groups --names "${TG_PREFIX}-${tg}" --region "$REGION" \
      --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo "")
    [ -n "$TG_ARN" ] && [ "$TG_ARN" != None ] || { echo "  skipped: ${TG_PREFIX}-${tg} (no such target group)"; continue; }
    alarm "crm-${ENV_NAME}-${svc}-unhealthy" \
      "${svc} is running but failing its health check - it is not serving traffic and ECS will not replace it" \
      UnHealthyHostCount AWS/ApplicationELB \
      "Name=TargetGroup,Value=${TG_ARN##*:} Name=LoadBalancer,Value=${LB_DIM}" \
      Maximum 60 3 0 GreaterThanThreshold notBreaching
  done
else
  echo "  skipped: unhealthy-host alarms (load balancer crm-alb not found)"
fi

echo
echo "==> Done. Confirm the SNS subscription is CONFIRMED, or nothing is delivered:"
echo "    aws sns list-subscriptions-by-topic --topic-arn $TOPIC --region $REGION"
echo
echo "Note: alarms 1-4 need Container Insights on the cluster:"
echo "    aws ecs update-cluster-settings --cluster $CLUSTER \\"
echo "      --settings name=containerInsights,value=enabled --region $REGION"
echo "Without it RunningTaskCount is never published and the alarms stay silent."
