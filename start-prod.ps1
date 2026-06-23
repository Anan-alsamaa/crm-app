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
param([switch]$Force)

# SAFETY GUARD (added 2026-06-14): Yiji CRM now runs the Docker backend
# (`docker compose up -d` from crm-app-infra) + frontends via `pnpm dev`, per PRD §21.
# This native pm2 stack conflicts on ports 8080 / 5173-5175 and must NOT run beside Docker.
# Refuse by default; pass -Force only if you deliberately want the legacy native stack.
if (-not $Force) {
  Write-Warning 'start-prod.ps1 is DISABLED: the project runs via Docker (backend) + pnpm dev (frontends).'
  Write-Warning 'The native pm2 stack conflicts on ports 8080/5173-5175.'
  Write-Warning 'Backend:  docker compose up -d            (from crm-app-infra)'
  Write-Warning 'Frontend: pnpm --filter "@yiji/agent-portal" --filter "@yiji/admin-portal" --filter "@yiji/chat-widget" --parallel dev'
  Write-Warning 'If you truly need the legacy native stack, re-run:  ./start-prod.ps1 -Force'
  exit 1
}

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
