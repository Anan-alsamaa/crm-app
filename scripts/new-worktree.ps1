<#
.SYNOPSIS
  Create an isolated git worktree so a feature can be built in its own Claude
  Code session without colliding with the others.

.DESCRIPTION
  Each worktree is a full checkout of this repo on its own branch, in its own
  folder, sharing one .git directory. Two sessions editing the same working tree
  overwrite each other's files and produce tangled commits; two worktrees cannot.

  Three things git does NOT carry into a new worktree, and this script does:

    1. .env files are gitignored, so a fresh worktree has no configuration and
       every service fails to start. They are copied from the main checkout.
    2. node_modules is per-directory. pnpm install is run (fast — the global
       store is shared, so it is mostly hardlinks).
    3. Dev-server ports are hardcoded in vite.config.ts. Each worktree gets a
       slot number, and the printed commands pass --port so several portals can
       run at once.

  The backing services (postgres, redis, directus, gateway, workers) are SHARED
  across worktrees on purpose — they hold one database, and running five copies
  would be pointless as well as impossible on these ports.

.PARAMETER Name
  Short kebab-case feature name. Becomes branch "feat/<Name>" and folder
  "../crm-app-wt/<Name>".

.PARAMETER Slot
  1-9. Decides the dev-server ports for this worktree (slot 1 -> 5183/5184/5185).

.PARAMETER From
  Base branch. Defaults to main.

.EXAMPLE
  ./scripts/new-worktree.ps1 -Name new-complaint-form -Slot 1
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][ValidateRange(1, 9)][int]$Slot,
  [string]$From = 'main'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $repo
$dest = Join-Path $root "crm-app-wt\$Name"
$branch = "feat/$Name"

if (Test-Path $dest) { throw "$dest already exists. Pick another name or remove it." }

Write-Host "Creating worktree $branch -> $dest" -ForegroundColor Cyan
git -C $repo worktree add -b $branch $dest $From
if ($LASTEXITCODE -ne 0) { throw 'git worktree add failed' }

# 1. Configuration. Gitignored by design, so git will never bring these across;
#    without them Directus/gateway/portals all start with empty config.
$envFiles = @(
  '.env',
  '.env.aws.local',
  '.env.prod',
  '.env.prod.smoke',
  'apps/admin-portal/.env.local',
  'apps/agent-portal/.env.local',
  'apps/chat-widget/.env.local',
  'directus/local/.env'
)
foreach ($f in $envFiles) {
  $src = Join-Path $repo $f
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $dest $f
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  Copy-Item $src $dst -Force
  Write-Host "  env  $f"
}

# 2. Dependencies.
Write-Host 'Installing dependencies (shared pnpm store, mostly hardlinks)...' -ForegroundColor Cyan
Push-Location $dest
try {
  pnpm install --prefer-offline
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
}
finally { Pop-Location }

# 3. Ports. vite.config.ts hardcodes 5173/5174/5175, so every worktree would
#    fight for the same three ports; --port on the CLI wins over the config.
$agent = 5173 + ($Slot * 10)
$admin = 5174 + ($Slot * 10)
$widget = 5175 + ($Slot * 10)

Write-Host ''
Write-Host "Worktree ready: $dest" -ForegroundColor Green
Write-Host "  branch      $branch (from $From)"
Write-Host "  open a NEW Claude Code session with that folder as its working directory"
Write-Host ''
Write-Host '  dev servers for this worktree (backing services are shared, do not restart them):'
Write-Host "    pnpm --filter @yiji/agent-portal dev -- --port $agent"
Write-Host "    pnpm --filter @yiji/admin-portal dev -- --port $admin"
Write-Host "    pnpm --filter @yiji/chat-widget  dev -- --port $widget"
Write-Host ''
Write-Host '  when the feature is done:'
Write-Host "    pnpm verify   (in the worktree)"
Write-Host "    git -C `"$repo`" merge --no-ff $branch"
Write-Host "    git -C `"$repo`" worktree remove `"$dest`""
Write-Host "    git -C `"$repo`" branch -d $branch"
