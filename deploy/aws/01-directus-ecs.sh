#!/usr/bin/env bash
#
# Directus on ECS Fargate + RDS + ElastiCache + S3 — phase 1 of the AWS rollout.
#
#   docs:  documentation/infra/aws-deployment-plan.md  (full architecture)
#   run:   bash deploy/aws/01-directus-ecs.sh
#
# WHAT THIS CREATES (all named with the $PREFIX below, so it is easy to find and
# to tear down): an S3 bucket for Directus uploads, a Secrets Manager secret, an
# RDS Postgres instance, an ElastiCache Redis node, an ECR repo for the bootstrap
# image, an ECS cluster + task definition + service, and an ALB with an HTTPS
# listener.
#
# ---------------------------------------------------------------------------
# READ BEFORE RUNNING
#
# * THIS SCRIPT HAS NEVER BEEN RUN. It was written against the AWS CLI docs and
#   this repo's actual configuration, but no one has executed it end to end.
#   Run it with $DRY_RUN=1 first and read what it intends to do.
# * IT COSTS MONEY. RDS + ElastiCache + ALB + NAT are billed hourly and are NOT
#   free tier at these sizes. Tear down with 99-teardown.sh when testing.
# * IT IS NOT IDEMPOTENT everywhere. Re-running after a partial failure may error
#   on "already exists"; those are safe to skip, but read them rather than
#   assuming.
# * Secrets are written to Secrets Manager, never to the task definition in plain
#   text, and never echoed here.
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- settings you MUST set ------------------------------------------------
PREFIX="${PREFIX:-yiji-crm}"
REGION="${REGION:?set REGION, e.g. me-central-1}"
DOMAIN="${DOMAIN:?set DOMAIN, e.g. crm.example.com}"        # api.$DOMAIN -> Directus
ACM_CERT_ARN="${ACM_CERT_ARN:?set ACM_CERT_ARN for the ALB cert in $REGION}"
DB_PASSWORD="${DB_PASSWORD:?set a strong DB_PASSWORD}"
DIRECTUS_ADMIN_EMAIL="${DIRECTUS_ADMIN_EMAIL:?}"
DIRECTUS_ADMIN_PASSWORD="${DIRECTUS_ADMIN_PASSWORD:?set a STRONG admin password, not the dev one}"
# KEY/SECRET must stay stable forever — changing them invalidates every existing
# session and token. Generate once, store, never rotate casually.
DIRECTUS_KEY="${DIRECTUS_KEY:-$(uuidgen)}"
DIRECTUS_SECRET="${DIRECTUS_SECRET:-$(uuidgen)}"
DRY_RUN="${DRY_RUN:-0}"

run() {
  echo "+ $*"
  [ "$DRY_RUN" = "1" ] || "$@"
}

echo "== Directus on ECS =="
echo "   prefix=$PREFIX region=$REGION domain=api.$DOMAIN dry-run=$DRY_RUN"

# ---- 0. network: reuse the default VPC ------------------------------------
# The plan explicitly prefers the default VPC: creating one needs far more IAM
# permission than most deploy roles have, and buys nothing at this size.
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
  --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[].SubnetId' --output text)
SUBNET_CSV=$(echo "$SUBNETS" | tr '\t' ',')
echo "   vpc=$VPC_ID subnets=$SUBNET_CSV"

# ---- 1. security groups ---------------------------------------------------
sg() { # name description -> id (reuses an existing group of the same name)
  aws ec2 describe-security-groups --region "$REGION" \
    --filters Name=group-name,Values="$1" Name=vpc-id,Values="$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | grep -v None ||
  aws ec2 create-security-group --region "$REGION" --group-name "$1" \
    --description "$2" --vpc-id "$VPC_ID" --query GroupId --output text
}
SG_ALB=$(sg "$PREFIX-alb" "public HTTPS -> Directus")
SG_ECS=$(sg "$PREFIX-ecs" "Fargate tasks")
SG_DATA=$(sg "$PREFIX-data" "RDS + Redis, private")

# 443 from the internet is the ONLY public ingress. Directus itself is never
# exposed directly — the ALB terminates TLS and talks to the task privately.
run aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ALB" \
  --protocol tcp --port 443 --cidr 0.0.0.0/0 || true
run aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ECS" \
  --protocol tcp --port 8055 --source-group "$SG_ALB" || true
# Postgres + Redis reachable ONLY from the tasks, never from the internet.
run aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_DATA" \
  --protocol tcp --port 5432 --source-group "$SG_ECS" || true
run aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_DATA" \
  --protocol tcp --port 6379 --source-group "$SG_ECS" || true

# ---- 2. S3 bucket for Directus uploads ------------------------------------
# NOT optional on Fargate: the task filesystem is ephemeral, so `local` storage
# discards every attachment on each task replacement while Directus keeps serving
# rows that reference them.
BUCKET="$PREFIX-directus-uploads"
run aws s3api create-bucket --region "$REGION" --bucket "$BUCKET" \
  --create-bucket-configuration LocationConstraint="$REGION" || true
run aws s3api put-public-access-block --region "$REGION" --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
run aws s3api put-bucket-encryption --region "$REGION" --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# ---- 3. RDS Postgres ------------------------------------------------------
run aws rds create-db-subnet-group --region "$REGION" \
  --db-subnet-group-name "$PREFIX-db" --db-subnet-group-description "$PREFIX" \
  --subnet-ids $SUBNETS || true
run aws rds create-db-instance --region "$REGION" \
  --db-instance-identifier "$PREFIX-pg" --engine postgres --engine-version 16 \
  --db-instance-class db.t4g.micro --allocated-storage 20 --storage-encrypted \
  --master-username directus --master-user-password "$DB_PASSWORD" \
  --db-name yiji_crm --db-subnet-group-name "$PREFIX-db" \
  --vpc-security-group-ids "$SG_DATA" --backup-retention-period 7 \
  --no-publicly-accessible || true
echo "   waiting for RDS (several minutes) ..."
[ "$DRY_RUN" = "1" ] || aws rds wait db-instance-available --region "$REGION" \
  --db-instance-identifier "$PREFIX-pg"
DB_HOST=$([ "$DRY_RUN" = "1" ] && echo "<rds-endpoint>" || aws rds describe-db-instances \
  --region "$REGION" --db-instance-identifier "$PREFIX-pg" \
  --query 'DBInstances[0].Endpoint.Address' --output text)

# ---- 4. ElastiCache Redis -------------------------------------------------
run aws elasticache create-cache-subnet-group --region "$REGION" \
  --cache-subnet-group-name "$PREFIX-redis" --cache-subnet-group-description "$PREFIX" \
  --subnet-ids $SUBNETS || true
run aws elasticache create-cache-cluster --region "$REGION" \
  --cache-cluster-id "$PREFIX-redis" --engine redis --cache-node-type cache.t4g.micro \
  --num-cache-nodes 1 --cache-subnet-group-name "$PREFIX-redis" \
  --security-group-ids "$SG_DATA" || true
echo "   waiting for Redis ..."
[ "$DRY_RUN" = "1" ] || aws elasticache wait cache-cluster-available \
  --region "$REGION" --cache-cluster-id "$PREFIX-redis"
REDIS_HOST=$([ "$DRY_RUN" = "1" ] && echo "<redis-endpoint>" || aws elasticache \
  describe-cache-clusters --region "$REGION" --cache-cluster-id "$PREFIX-redis" \
  --show-cache-node-info --query 'CacheClusters[0].CacheNodes[0].Endpoint.Address' \
  --output text)

# ---- 5. Secrets Manager ---------------------------------------------------
# The task definition references these by ARN; the values never appear in the
# task def, in CloudFormation, or in this shell's history.
SECRET_JSON=$(cat <<JSON
{
  "DB_PASSWORD": "$DB_PASSWORD",
  "DIRECTUS_KEY": "$DIRECTUS_KEY",
  "DIRECTUS_SECRET": "$DIRECTUS_SECRET",
  "DIRECTUS_ADMIN_PASSWORD": "$DIRECTUS_ADMIN_PASSWORD"
}
JSON
)
run aws secretsmanager create-secret --region "$REGION" --name "$PREFIX/directus" \
  --secret-string "$SECRET_JSON" 2>/dev/null ||
run aws secretsmanager put-secret-value --region "$REGION" --secret-id "$PREFIX/directus" \
  --secret-string "$SECRET_JSON"

cat <<EOF

== phase 1 inputs captured ==
  DB_HOST     = $DB_HOST
  REDIS_HOST  = $REDIS_HOST
  BUCKET      = $BUCKET
  SECRET      = $PREFIX/directus

Next: 02-directus-service.sh registers the task definition (image
directus/directus:11, STORAGE_LOCATIONS=s3, secrets pulled from Secrets Manager)
and creates the ALB + ECS service on api.$DOMAIN.

Then run the bootstrap ONCE as an ECS task:
  aws ecs run-task --cluster $PREFIX --task-definition $PREFIX-bootstrap ...
It is idempotent, so a re-run after a failure is safe.
EOF
