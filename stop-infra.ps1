# stop-infra.ps1 — the safe "close docker" for the hybrid local topology.
#
# `down` removes the infra containers + the project network but KEEPS the named
# volumes (postgres_data, redis_data, directus_uploads), so all data persists
# across a close/open cycle. Pair with start-infra.ps1 to reopen.
#
# Note: the PM2 app services (socket-gateway/ai-gateway/workers) keep running and
# will reconnect once infra is back; after a close/open, `pm2 restart all` gives
# them a clean reconnect to the fresh infra.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

docker compose down

Write-Host ''
Write-Host 'Infra stopped (data volumes preserved). Reopen with: ./start-infra.ps1' -ForegroundColor Green
