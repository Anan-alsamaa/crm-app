# start-prod.ps1 — bring up the local production-like Yiji CRM stack.
#
#   pwsh ./start-prod.ps1
#
# Prereqs (must already be running):
#   - PostgreSQL on :5432 (native service), database `yiji_crm`, user directus/directus
#   - .env.prod present in this folder (real secrets; gitignored)
# Brings up:
#   - Redis on :6390 (standalone — pm2 can't supervise a Windows .exe)
#   - pm2 stack from ecosystem.config.cjs: directus, socket-gateway, ai-gateway,
#     workers, agent-portal, admin-portal, chat-widget
$ErrorActionPreference = 'Stop'
$infra = $PSScriptRoot
$redisDir = Join-Path (Split-Path $infra -Parent) 'crm-app-frontend\.redis-win'

if (-not (Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue)) {
  Write-Warning 'PostgreSQL is not listening on :5432 — start it first.'
}

if (-not (Get-NetTCPConnection -LocalPort 6390 -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host 'Starting Redis on :6390 ...'
  Start-Process -FilePath (Join-Path $redisDir 'redis-server.exe') `
    -ArgumentList (Join-Path $redisDir 'redis-6390.conf') -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

Write-Host 'Starting pm2 stack ...'
pm2 start (Join-Path $infra 'ecosystem.config.cjs')
pm2 save
pm2 status
Write-Host ''
Write-Host 'Up. Agent http://localhost:5173  Admin http://localhost:5174  Widget http://localhost:5175'
Write-Host 'Directus http://localhost:8055  (admin: e.habibi@anan.sa / 123456)'
