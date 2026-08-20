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
  $proc = $procs | Where-Object { $_.name -eq $name } | Select-Object -First 1
  $restarts = if ($proc) { [int]$proc.pm2_env.restart_time } else { 0 }
  # A CRASH LOOP reads as "online", because PM2 keeps restarting it and catches
  # it in the moment it is up. socket-gateway once sat at 4,477 restarts while
  # every check said online: an orphaned copy from a dead PM2 daemon still held
  # :8080, so the supervised one could never bind. Uptime is the tell.
  $uptimeSec = if ($proc -and $proc.pm2_env.pm_uptime) {
    [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$proc.pm2_env.pm_uptime) / 1000)
  }
  else { 999 }
  $looping = $up -and $uptimeSec -lt 20
  Report ($up -and -not $looping) $name $(if ($looping) { "CRASH LOOPING - $restarts restarts, up $uptimeSec s" } elseif ($restarts -gt 50) { "$restarts restarts" } else { '' })
  if (-not $up) { $problems += "pm2 process $name is not online" }
  elseif ($looping) {
    $problems += "pm2 process $name is crash-looping ($restarts restarts). Something else may already hold its port - find it with: Get-NetTCPConnection -LocalPort <port> -State Listen, then Stop-Process on the owning PID."
  }
}

# ── Ports: what actually answers ──────────────────────────────────────────
# A process can be "online" in PM2 and still not be listening — it is online
# from the moment it is spawned, which is before it has bound anything.
Write-Host "`nPorts" -ForegroundColor Cyan
$ports = @(
  @{ p = 5434; what = 'postgres' },
  @{ p = 6380; what = 'redis' },
  @{ p = 8055; what = 'directus' },
  @{ p = 8080; what = 'socket-gateway  <- live chat' },
  # The gateway serves socket.io on PORT and its health/metrics on PORT+1.
  # This script used to probe 8080/health and pass, because a STALE orphan
  # answered there while the real one crash-looped — the wrong probe on the
  # wrong port, agreeing with itself.
  @{ p = 8081; what = 'socket-gateway health' },
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
# /health is not enough on its own: a STALE process answers it perfectly while
# serving none of the routes anything actually uses. Each entry here is a route
# the product depends on, not just a liveness ping.
foreach ($u in @('http://localhost:8085/health',
    'http://localhost:8081/health',
    'http://localhost:8080/socket.io/?EIO=4&transport=polling',
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
