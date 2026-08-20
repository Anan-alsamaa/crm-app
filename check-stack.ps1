# check-stack.ps1 — verify the whole local stack, and repair what it can.
#
#   pwsh ./check-stack.ps1          # check and repair, then report
#   pwsh ./check-stack.ps1 -Check   # report only, change nothing
#
# RUN THIS BEFORE A DEMO. Everything the portals do beyond reading the database
# goes through a PM2 process, and PM2 on Windows loses its entire process list
# whenever its daemon dies — a reboot, a wedged Docker, or the box running out
# of memory during a build. The portals keep serving (nginx has the built
# files), so the failure does not look like a failure: the pages load, and only
# the AI panel and the order lookup say "failed to fetch". That symptom has now
# been diagnosed from scratch several times. This script is the diagnosis.
#
# Exit code 0 = everything answered. Non-zero = something is still down, and
# the line above it says what.
param([switch]$Check)

$ErrorActionPreference = 'Continue'
$repair = -not $Check
$problems = @()
$repaired = @()

function Report($ok, $name, $detail) {
  if ($ok) { Write-Host ("  OK    {0,-22} {1}" -f $name, $detail) -ForegroundColor Green }
  else { Write-Host ("  DOWN  {0,-22} {1}" -f $name, $detail) -ForegroundColor Red }
}

# ── Docker: the data layer and the portal web server ──────────────────────
# The portals are static files served by the yiji-portals nginx container, so
# this container being down is the only failure that looks like a failure.
$containers = @(
  @{ name = 'crm-app-infra-postgres-1'; what = 'postgres :5434' },
  @{ name = 'crm-app-infra-redis-1'; what = 'redis :6380' },
  @{ name = 'crm-app-infra-directus-1'; what = 'directus :8055' },
  @{ name = 'yiji-portals'; what = 'portals :8090 :8092' }
)

Write-Host "`nDocker" -ForegroundColor Cyan
foreach ($c in $containers) {
  $state = (docker inspect -f '{{.State.Status}}' $c.name 2>$null)
  if ($state -ne 'running' -and $repair) {
    Write-Host "  starting $($c.name) ..." -ForegroundColor Yellow
    docker start $c.name *> $null
    Start-Sleep -Seconds 3
    $state = (docker inspect -f '{{.State.Status}}' $c.name 2>$null)
    if ($state -eq 'running') { $repaired += $c.name }
  }
  Report ($state -eq 'running') $c.name $c.what
  if ($state -ne 'running') { $problems += "$($c.name) is $(if($state){$state}else{'missing'})" }
}

# ── PM2: everything the portals call ──────────────────────────────────────
# An EMPTY list is the failure mode to watch for, not a crashed process. When
# the daemon respawns it comes back with nothing running and says so only if
# you look; `pm2 resurrect` replays the saved dump.
Write-Host "`nPM2" -ForegroundColor Cyan
$expected = @('socket-gateway', 'ai-gateway', 'workers', 'chat-widget-demo')

function Pm2Names {
  # -AsHashtable: pm2's JSON carries both `username` and `USERNAME`, which
  # ConvertFrom-Json refuses as a duplicate key without it.
  try { (pm2 jlist 2>$null | ConvertFrom-Json -AsHashtable) } catch { @() }
}

$procs = Pm2Names
$online = @($procs | Where-Object { $_.pm2_env.status -eq 'online' } | ForEach-Object { $_.name })
$missing = @($expected | Where-Object { $online -notcontains $_ })

if ($missing.Count -gt 0 -and $repair) {
  Write-Host "  $($missing.Count) process(es) not online — resurrecting from the saved dump ..." -ForegroundColor Yellow
  pm2 resurrect *> $null
  Start-Sleep -Seconds 5
  $procs = Pm2Names
  $online = @($procs | Where-Object { $_.pm2_env.status -eq 'online' } | ForEach-Object { $_.name })
  # Resurrect only replays the dump; anything in it that then crashed needs a
  # restart of its own.
  foreach ($name in @($expected | Where-Object { $online -notcontains $_ })) {
    pm2 restart $name *> $null
  }
  Start-Sleep -Seconds 3
  $procs = Pm2Names
  $online = @($procs | Where-Object { $_.pm2_env.status -eq 'online' } | ForEach-Object { $_.name })
  $repaired += @($missing | Where-Object { $online -contains $_ })
}

foreach ($name in $expected) {
  $up = $online -contains $name
  Report $up $name ''
  if (-not $up) { $problems += "pm2 process $name is not online" }
}

# ── Ports: what actually answers ──────────────────────────────────────────
# A process can be "online" in PM2 and still not be listening — it is online
# from the moment it is spawned, which is before it has bound anything.
Write-Host "`nPorts" -ForegroundColor Cyan
$ports = @(
  @{ p = 5434; what = 'postgres' },
  @{ p = 6380; what = 'redis' },
  @{ p = 8055; what = 'directus' },
  @{ p = 8080; what = 'socket-gateway' },
  @{ p = 8083; what = 'workers' },
  @{ p = 8085; what = 'ai-gateway  <- AI panel + order lookup' },
  @{ p = 8090; what = 'agent portal' },
  @{ p = 8092; what = 'admin portal' },
  @{ p = 5175; what = 'chat widget' }
)
foreach ($e in $ports) {
  $listening = [bool](Get-NetTCPConnection -LocalPort $e.p -State Listen -ErrorAction SilentlyContinue)
  Report $listening ":$($e.p)" $e.what
  if (-not $listening) { $problems += "nothing is listening on :$($e.p) ($($e.what))" }
}

# ── The two endpoints whose absence is invisible from the portals ─────────
Write-Host "`nEndpoints" -ForegroundColor Cyan
foreach ($u in @('http://localhost:8085/health', 'http://localhost:8080/health',
    'http://localhost:8090/', 'http://localhost:8092/')) {
  try {
    $r = Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 8
    Report ($r.StatusCode -eq 200) $u "HTTP $($r.StatusCode)"
    if ($r.StatusCode -ne 200) { $problems += "$u returned $($r.StatusCode)" }
  }
  catch {
    Report $false $u 'no answer'
    $problems += "$u did not answer"
  }
}

# Save whatever is running now, so the next daemon death is recoverable. This
# is the step that was missed the first time this happened: without a dump,
# `pm2 resurrect` has nothing to replay.
if ($repair -and $problems.Count -eq 0) { pm2 save *> $null }

Write-Host ''
if ($repaired.Count -gt 0) {
  Write-Host "Repaired: $($repaired -join ', ')" -ForegroundColor Yellow
}
if ($problems.Count -eq 0) {
  Write-Host 'Stack is healthy — every service answered.' -ForegroundColor Green
  exit 0
}
Write-Host 'STILL DOWN:' -ForegroundColor Red
$problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
Write-Host ''
Write-Host 'If Docker itself is wedged: kill the Docker processes, run `wsl --shutdown`, relaunch Docker Desktop, then re-run this script.'
exit 1
