# start-portals.ps1 — (re)create the yiji-portals nginx container.
#
#   pwsh ./start-portals.ps1
#
# The static portals tier: nginx:alpine serving apps/agent-portal/dist on :8090
# and apps/admin-portal/dist on :8092 (loopback only), config from
# deploy/nginx.local.conf. This container used to exist only as a live object
# with no definition in the repo — losing it meant reconstructing the mounts
# from memory. This script IS the definition now.
#
# A healthcheck is baked in so `docker ps` says "unhealthy" when nginx stops
# answering — which has happened (a Docker Desktop stall left it running but
# unresponsive, and every portal just spun). The remedy is the same either way:
#   docker restart yiji-portals
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

docker rm -f yiji-portals 2>$null | Out-Null

docker run -d --name yiji-portals `
  --restart unless-stopped `
  -p 127.0.0.1:8090:8090 `
  -p 127.0.0.1:8092:8092 `
  -v "${root}/deploy/nginx.local.conf:/etc/nginx/conf.d/default.conf:ro" `
  -v "${root}/apps/agent-portal/dist:/www/agent:ro" `
  -v "${root}/apps/admin-portal/dist:/www/admin:ro" `
  --health-cmd "wget -q -O /dev/null http://127.0.0.1:8090/ || exit 1" `
  --health-interval 30s --health-timeout 5s --health-retries 3 `
  nginx:alpine

docker ps --filter name=yiji-portals --format '{{.Names}}: {{.Status}}'
