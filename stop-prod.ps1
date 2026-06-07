# stop-prod.ps1 — stop the local production-like stack (leaves Postgres alone).
$ErrorActionPreference = 'SilentlyContinue'
pm2 delete all
# Redis runs standalone; stop the one on :6390.
$c = Get-NetTCPConnection -LocalPort 6390 -State Listen | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
Write-Host 'Stopped pm2 apps + Redis (Postgres left running).'
