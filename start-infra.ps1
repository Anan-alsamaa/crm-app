# start-infra.ps1 — bring up the infra tier (Postgres + Redis + Directus).
#
# HYBRID local topology: Docker runs infra; the app services (socket-gateway,
# ai-gateway, workers) run under PM2 from crm-app/ecosystem.config.cjs.
#
# The app services are gated behind the Compose `app` profile, so a bare
# `docker compose up -d` brings up INFRA ONLY and can no longer collide with the
# PM2 stack. (Full Docker stack instead of PM2:  docker compose --profile app up -d)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

docker compose up -d
docker compose ps

Write-Host ''
Write-Host 'Infra up: postgres (5433) - redis (6380) - directus (8055).' -ForegroundColor Green
Write-Host 'App tier is PM2:  cd ../crm-app ; pm2 start ecosystem.config.cjs   (or: pm2 resurrect)' -ForegroundColor Yellow
