#!/usr/bin/env bash
#
# deploy-service.sh — build, push and roll out ONE backend service.
#
#   scripts/deploy-service.sh staging socket-gateway
#   scripts/deploy-service.sh staging directus workers      # several, in order
#   scripts/deploy-service.sh staging --all
#   SKIP_BUILD=1 scripts/deploy-service.sh staging workers  # image already pushed
#
# WHY THIS EXISTS
#
# Every service rollout was hand-typed: docker build, docker push, edit the task
# definition JSON, register, update-service, wait. Six commands with no checks
# between them, and the failure mode is not theoretical — it happened.
#
# The ECR login expired mid-run. Both `docker push` calls answered 403, the
# script carried on, registered task definitions pointing at images that had
# never uploaded, and told ECS to deploy them. The old tasks kept serving (so
# there was no outage) while the new ones could not start, and the rollout sat
# IN_PROGRESS with 0 running for as long as anyone left it. Nothing in the
# sequence said "the image is not there" — a registered task definition looks
# exactly the same whether its image exists or not.
#
# So the rule here: NOTHING is registered until the image is confirmed present
# in ECR by digest. Everything else follows from that.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REGION="${AWS_REGION:-us-east-2}"
ACCOUNT="${AWS_ACCOUNT_ID:-408568863712}"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
ALL_SERVICES=(directus socket-gateway ai-gateway workers)

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Prerequisites, named before anything is attempted ─────────────────────
#
# A missing tool surfaced as the failure of whatever step happened to need it
# first — `docker login` reporting bad AWS credentials when the real problem
# was that `aws` was not on PATH at all. On this machine the three live under
# Program Files and are present in Git Bash's PATH but not always in a bash
# launched from PowerShell, so the common fix is to add them rather than to
# install anything.
MISSING=()
for tool in aws docker node git; do
  command -v "$tool" >/dev/null 2>&1 || MISSING+=("$tool")
done
# docker is only needed when something is actually built.
if [ "${SKIP_BUILD:-}" = "1" ]; then
  MISSING=("${MISSING[@]/docker}")
fi
MISSING=($(printf '%s\n' "${MISSING[@]:-}" | grep -v '^$' || true))
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "FAIL: not on PATH: ${MISSING[*]}" >&2
  echo "      On Windows these usually live under Program Files; try:" >&2
  echo '      export PATH="$PATH:/c/Program Files/Amazon/AWSCLIV2:/c/Program Files/nodejs:/c/Program Files/Docker/Docker/resources/bin"' >&2
  exit 2
fi

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  staging|prod) shift ;;
  *) echo "usage: $0 <staging|prod> <service...|--all>" >&2; exit 2 ;;
esac
[ $# -gt 0 ] || { echo "name at least one service, or --all" >&2; exit 2; }

if [ "$1" = "--all" ]; then
  SERVICES=("${ALL_SERVICES[@]}")
else
  SERVICES=("$@")
  for s in "${SERVICES[@]}"; do
    printf '%s\n' "${ALL_SERVICES[@]}" | grep -qx "$s" || die "unknown service '$s'"
  done
fi

# The commit being deployed. A SHA tag, not a moving one: `main` moves, and a
# rollback to a previous task-definition revision has to land on the image that
# revision actually ran.
SHA="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  info "WARNING: the working tree is dirty — the image will not match commit $SHA"
fi

# ── Dockerfile per service ────────────────────────────────────────────────
dockerfile_for() {
  case "$1" in
    directus) echo 'directus/Dockerfile' ;;
    *)        echo "services/$1/Dockerfile" ;;
  esac
}

# ── ECR login, once, up front ─────────────────────────────────────────────
#
# The token lasts 12 hours, and it expiring mid-run is the exact failure this
# script exists to prevent. Logging in here (rather than assuming a login from
# some earlier session) makes the window start now.
#
# Skipped entirely when there is nothing to push: SKIP_BUILD means the image
# is already in ECR, and the digest check below reads it through the AWS API,
# which needs no Docker credentials at all. Requiring a working `docker login`
# to verify an existing image would make this refuse for a reason unrelated to
# the thing it is checking — which is exactly what it did the first time.
if [ "${SKIP_BUILD:-}" = "1" ]; then
  say "skipping the ECR login — nothing to push (SKIP_BUILD=1)"
else
  say "authenticating to ECR"
  # Docker Desktop's credential helper is not always reachable from every
  # shell (Git Bash on Windows frequently cannot exec
  # `docker-credential-desktop`). When that happens the login itself has
  # ALREADY succeeded and only the step that saves it to the credential store
  # fails — so treat that one error as non-fatal and let the push decide,
  # rather than refusing a deploy that would have worked.
  LOGIN_OUT="$(aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY" 2>&1 || true)"
  if grep -qi "login succeeded" <<<"$LOGIN_OUT"; then
    ok "logged in to $REGISTRY"
  elif grep -qi "error saving credentials" <<<"$LOGIN_OUT"; then
    info "logged in; the credential store is unavailable in this shell (harmless)"
  else
    printf %s\\n "$LOGIN_OUT" >&2
    die "could not log in to ECR — check your AWS credentials (and that the Docker daemon is running)"
  fi
fi

# ── Is this image in ECR? ─────────────────────────────────────────────────
#
# The whole point. `describe-images` on the tag either returns a digest or
# fails; there is no ambiguous middle. Called AFTER the push and again before
# the register, because those are two different questions: "did the push work"
# and "is what I am about to deploy actually there".
image_digest() {
  aws ecr describe-images \
    --region "$REGION" \
    --repository-name "crm/$1" \
    --image-ids "imageTag=sha-$SHA" \
    --query 'imageDetails[0].imageDigest' \
    --output text 2>/dev/null || true
}

for SVC in "${SERVICES[@]}"; do
  say "$SVC"
  REPO="${REGISTRY}/crm/${SVC}"
  DOCKERFILE="$(dockerfile_for "$SVC")"
  [ -f "$DOCKERFILE" ] || die "$DOCKERFILE does not exist"

  if [ "${SKIP_BUILD:-}" = "1" ]; then
    info "SKIP_BUILD=1 — using whatever is already tagged"
  else
    info "building from $DOCKERFILE"
    docker build -f "$DOCKERFILE" -t "${REPO}:sha-${SHA}" -t "${REPO}:main" . >/dev/null \
      || die "$SVC image build failed"
    ok "built ${REPO}:sha-${SHA:0:12}"

    info "pushing"
    # `docker push` can print an error and still exit 0 on some daemons, which
    # is half the reason the digest check below exists rather than trusting $?.
    docker push "${REPO}:sha-${SHA}" >/dev/null || die "$SVC push failed"
    docker push "${REPO}:main"        >/dev/null || die "$SVC push (main tag) failed"
  fi

  DIGEST="$(image_digest "$SVC")"
  [ -n "$DIGEST" ] && [ "$DIGEST" != "None" ] \
    || die "$SVC: sha-$SHA is NOT in ECR. Nothing registered, nothing deployed."
  ok "confirmed in ECR: ${DIGEST:0:19}…"

  # ── Task definition ─────────────────────────────────────────────────────
  #
  # Taken from what is DEPLOYED, not from the JSON in the repo: the live
  # revision carries the environment values (secrets, URLs) that the template
  # only has placeholders for. Only the image changes.
  # Written INSIDE the repo, not into /tmp.
  #
  # `aws` may be a Windows binary while this runs in Git Bash, and a Windows
  # program cannot open a Unix path like /tmp/xyz — the register step failed
  # with "No such file or directory" on a file that plainly existed. A relative
  # path in the working directory is understood by both.
  TD_FILE=".taskdef-${SVC}.json"
  trap 'rm -f "$TD_FILE"' EXIT
  aws ecs describe-task-definition \
    --region "$REGION" --task-definition "crm-${ENV_NAME}-${SVC}" \
    --query 'taskDefinition' --output json > "$TD_FILE" \
    || die "no existing task definition for crm-${ENV_NAME}-${SVC}"

  node -e '
    const fs = require("fs");
    const [file, image] = process.argv.slice(1);
    const td = JSON.parse(fs.readFileSync(file, "utf8"));
    // describe-task-definition returns fields register-task-definition rejects.
    for (const k of ["taskDefinitionArn","revision","status","requiresAttributes",
                     "compatibilities","registeredAt","registeredBy","deregisteredAt"]) delete td[k];
    const c = td.containerDefinitions[0];
    console.log(`    image ${c.image.split(":").pop().slice(0,16)} -> ${image.split(":").pop().slice(0,16)}`);
    c.image = image;
    fs.writeFileSync(file, JSON.stringify(td, null, 2));
  ' "$TD_FILE" "${REPO}:sha-${SHA}"

  # Staging must never deliver coupons. Same guard as the CI workflow: delivery
  # runs off a BACKLOG, so the first sweep after it is switched on sends every
  # approved-undelivered coupon at once, to real customers.
  if [ "$SVC" = "workers" ] && [ "$ENV_NAME" != "prod" ]; then
    if grep -A1 '"YIJI_COUPON_DELIVERY"' "$TD_FILE" | grep -q '"on"'; then
      die "YIJI_COUPON_DELIVERY=on on a non-production deploy — refusing"
    fi
    ok "coupon delivery correctly off"
  fi

  REV="$(aws ecs register-task-definition --region "$REGION" \
          --cli-input-json "file://./$TD_FILE" \
          --query 'taskDefinition.revision' --output text)"
  ok "registered crm-${ENV_NAME}-${SVC}:${REV}"

  aws ecs update-service --region "$REGION" \
    --cluster "crm-${ENV_NAME}" --service "$SVC" \
    --task-definition "crm-${ENV_NAME}-${SVC}:${REV}" \
    --query 'service.serviceName' --output text >/dev/null
  info "rolling out — waiting for steady state"

  # ECS keeps the old tasks serving until the new ones are healthy, so a failure
  # here is a stuck rollout rather than an outage. Failing the script is what
  # makes it visible instead of leaving it IN_PROGRESS for ever.
  aws ecs wait services-stable --region "$REGION" \
    --cluster "crm-${ENV_NAME}" --services "$SVC" \
    || die "$SVC did not reach steady state — check the service events"

  TASK="$(aws ecs list-tasks --region "$REGION" --cluster "crm-${ENV_NAME}" \
           --service-name "$SVC" --query 'taskArns[0]' --output text)"
  RUNNING="$(aws ecs describe-tasks --region "$REGION" --cluster "crm-${ENV_NAME}" \
              --tasks "$TASK" --query 'tasks[0].containers[0].image' --output text)"
  case "$RUNNING" in
    *"sha-${SHA}") ok "live on sha-${SHA:0:12} — healthy" ;;
    *) die "$SVC is stable but running $RUNNING, not the image just deployed" ;;
  esac
  rm -f "$TD_FILE"
  trap - EXIT
done

say "done"
info "deployed to $ENV_NAME at commit ${SHA:0:12}: ${SERVICES[*]}"
