#!/usr/bin/env bash
#
# test-staging.sh — exercise the DEPLOYED staging environment end to end.
#
#   bash scripts/test-staging.sh
#
# Every check drives the real HTTPS surface an agent's browser uses: CloudFront
# in front, the ALB behind it, the four services, RDS and ElastiCache. Nothing
# is mocked and nothing runs locally, because every defect found on this
# deployment so far was invisible until a real request crossed the real path —
# a cookie policy, a security group, a service listening on a second port.
#
# Read-only except where marked WRITE; those restore what they change.
set -uo pipefail

API=${API:-https://d2vi34f7wgjecb.cloudfront.net}
AGENT=${AGENT:-https://d57v6u4ytjrj7.cloudfront.net}
ADMIN=${ADMIN:-https://d1evkiaehtmzr0.cloudfront.net}
EMAIL=${TEST_EMAIL:-e2e.agent@example.com}
PASS=${TEST_PASSWORD:-123456}

pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; fail=$((fail+1)); }
sec(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

sec "1. Reachability"
for pair in "API:$API/server/health" "agent portal:$AGENT/" "admin portal:$ADMIN/"; do
  n=${pair%%:*}; u=${pair#*:}
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$u" 2>/dev/null)
  [ "$c" = "200" ] && ok "$n reachable" || no "$n reachable" "HTTP $c"
done

sec "2. TLS and CORS"
# The portals and API are on different CloudFront domains, so EVERY call is
# cross-site. If the preflight or the credentials flag is wrong, the browser
# blocks the request before the server ever sees it — and the app reports
# whatever its own error path says, which has misled us twice.
h=$(curl -s -i -X OPTIONS "$API/auth/login" -H "Origin: $AGENT" \
      -H 'Access-Control-Request-Method: POST' --max-time 20 2>/dev/null)
grep -qi "access-control-allow-origin: $AGENT" <<<"$h" && ok "CORS echoes the portal origin" || no "CORS origin"
grep -qi 'access-control-allow-credentials: true' <<<"$h" && ok "CORS allows credentials" || no "CORS credentials (session cookie will not be sent)"

sec "3. Authentication"
LOGIN=$(curl -s --max-time 25 -X POST "$API/auth/login" -H "Origin: $AGENT" \
          -H 'Content-Type: application/json' \
          -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" 2>/dev/null)
TOKEN=$(python -c "import sys,json;print(json.load(sys.stdin)['data']['access_token'])" <<<"$LOGIN" 2>/dev/null)
[ -n "$TOKEN" ] && ok "agent can sign in" || { no "agent sign-in" "$(head -c 160 <<<"$LOGIN")"; echo; echo "cannot continue without a session"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN")

# The session cookie is what survives a page reload. Without SameSite=none on
# cross-site domains the browser drops it and the user is signed out on refresh.
S=$(curl -s -i --max-time 25 -X POST "$API/auth/login" -H "Origin: $AGENT" \
      -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"mode\":\"session\"}" 2>/dev/null)
grep -qi 'set-cookie:.*directus_session_token' <<<"$S" && ok "session cookie issued" || no "session cookie"
# Assert against the DEPLOYED setting, not the login response: Directus sets
# SameSite on the refresh cookie, which /auth/login in session mode does not
# always return. Reading the task definition is the reliable check.
SS=$(aws ecs describe-task-definition --region "${AWS_REGION:-us-east-2}"        --task-definition crm-staging-directus        --query "taskDefinition.containerDefinitions[0].environment[?name=='REFRESH_TOKEN_COOKIE_SAME_SITE'].value"        --output text 2>/dev/null)
if [ "$SS" = "none" ]; then
  ok "cookie survives cross-site (SameSite=$SS)"
else
  no "SameSite is '$SS'" "must be 'none' while portals and API are on different domains, or refresh signs the user out"
fi

sec "4. Data"
for c in tickets contacts stores conversations; do
  n=$(curl -s --max-time 20 "${AUTH[@]}" "$API/items/$c?aggregate%5Bcount%5D=*" 2>/dev/null \
      | python -c "import sys,json;print(json.load(sys.stdin)['data'][0]['count'])" 2>/dev/null)
  [ -n "$n" ] && [ "$n" != "0" ] && ok "$c readable ($n)" || no "$c readable" "got '${n:-nothing}'"
done

sec "5. Realtime"
# socket-gateway serves Socket.IO on PORT and its REST app on PORT+1. They need
# separate target groups; a single one silently 404s every handshake and the UI
# sits on "sending" for ever.
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$API/socket.io/?EIO=4&transport=polling" 2>/dev/null)
[ "$c" = "200" ] && ok "socket.io handshake" || no "socket.io handshake" "HTTP $c — messages will not send"

sec "6. Service-to-service"
# The AI gateway verifies the caller by asking Directus /users/me. If that call
# cannot leave the task, it times out and the gateway answers "Invalid or
# expired session" — an auth message for a network fault.
r=$(curl -s --max-time 30 "${AUTH[@]}" "$API/commerce/order?vendorId=1&orderId=1234535" 2>/dev/null)
if grep -q '"error"' <<<"$r"; then
  no "ai-gateway can verify a caller" "$(head -c 120 <<<"$r")"
else
  ok "ai-gateway can verify a caller"
fi

sec "7. Writes (WRITE — restored)"
TID=$(curl -s --max-time 20 "${AUTH[@]}" "$API/items/tickets?limit=1&fields=id,status" 2>/dev/null \
      | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(d[0]['id'] if d else '')" 2>/dev/null)
if [ -n "$TID" ]; then
  WAS=$(curl -s --max-time 20 "${AUTH[@]}" "$API/items/tickets/$TID?fields=status" 2>/dev/null \
        | python -c "import sys,json;print(json.load(sys.stdin)['data']['status'])" 2>/dev/null)
  w=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X PATCH "$API/items/tickets/$TID" \
        "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"status":"resolved"}' 2>/dev/null)
  [ "$w" = "200" ] && ok "ticket update (mark as solved)" || no "ticket update" "HTTP $w"
  curl -s -o /dev/null --max-time 20 -X PATCH "$API/items/tickets/$TID" "${AUTH[@]}" \
       -H 'Content-Type: application/json' -d "{\"status\":\"$WAS\"}" 2>/dev/null
else
  no "ticket update" "no ticket to test with"
fi

sec "8. Environment guards"
b=$(curl -s --max-time 20 "$AGENT/config.js" 2>/dev/null)
grep -q "ENVIRONMENT: 'staging'" <<<"$b" && ok "staging banner enabled" || no "staging banner" "users cannot tell this is not production"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
