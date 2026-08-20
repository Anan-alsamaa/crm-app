# Running the stack locally

The local stack is a **hybrid**: Docker for the data layer and the portal web
server, PM2 for the four Node processes. Everything runs `NODE_ENV=production`
against real generated secrets, so it behaves like production without needing a
cluster.

> This file used to describe a pure-PM2 stack on a machine with no Docker, with
> a port table where every single row is now wrong. If something here disagrees
> with `check-stack.ps1`, believe the script — it is executable and this is
> prose.

## One command before anything else

```pwsh
pwsh ./check-stack.ps1        # check, repair what it can, report
pwsh ./check-stack.ps1 -Check # report only, change nothing
```

**Run this first whenever something "isn't working".** PM2 on Windows loses its
entire process list when its daemon dies — a reboot, a wedged Docker, or the box
running out of memory during a build. The portals keep serving, because nginx
has the built files and neither knows nor cares that the services behind them
are gone, so the failure does not look like one: pages load, and only the AI
panel and the order lookup say "failed to fetch".

## Topology

| Piece                 | Port | Runs under | Notes                                         |
| --------------------- | ---- | ---------- | --------------------------------------------- |
| PostgreSQL            | 5434 | Docker     | db `yiji_crm` (directus/directus)             |
| Redis                 | 6380 | Docker     |                                               |
| Directus              | 8055 | Docker     | admin UI + REST                               |
| socket-gateway        | 8080 | PM2        | socket.io — live chat                         |
| socket-gateway health | 8081 | PM2        | `/health` + `/metrics` — this is `PORT + 1`   |
| workers               | 8083 | PM2        | BullMQ: SLA sweep, notifications, reports     |
| ai-gateway            | 8085 | PM2        | AI panel, Aura, and the Yiji commerce proxy   |
| agent portal          | 8090 | Docker     | built SPA, served by the `yiji-portals` nginx |
| admin portal          | 8092 | Docker     | built SPA, same container                     |
| chat-widget demo      | 5175 | PM2        | vite dev server + host page                   |

The gateway serving health on `PORT + 1` is the detail that has cost the most
time: probing `8080/health` returns nothing even when live chat is perfectly
healthy, and once returned `200` from a stale orphan while the real gateway
crash-looped 4,477 times behind it.

## Start / stop

```pwsh
docker compose -f deploy/docker-compose.infra.yml up -d   # data layer
pwsh ./start-portals.ps1                                  # nginx portal container
pm2 resurrect                                             # the four Node processes
pm2 save                                                  # AFTER changing the process list
```

`pm2 save` is not optional housekeeping. Without a saved dump `pm2 resurrect`
has nothing to replay, and the next daemon death takes the whole stack with it
permanently.

## Credentials

- **Admin** (Directus + admin portal): `e.habibi@anan.sa` / `123456` — an email,
  and it stays one. Every provisioning script references it.
- **Agents**: an **employee ID**, not an email — `ali`, `nada`, `sultan`,
  `faisal`, `amjad`, `shatha`, `reyouf`, `aljouf`, all `123456`. The Directus
  identity is minted from it (`ali@staff.example.com`); nobody types that.
- **e2e**: `e2e-runner@example.com` / `123456`, deliberately still an email so
  the suite is unaffected by the employee-ID migration.

Change every one of these for a real deployment — see
[`GO-LIVE-READINESS.md`](./GO-LIVE-READINESS.md).

## Rebuilding the portals

`VITE_*` are baked at build time, so a portal change needs a rebuild, not a
restart:

```pwsh
pnpm --filter @yiji/agent-portal build
pnpm --filter @yiji/admin-portal build
```

nginx picks the new files up immediately. If a page looks stale afterwards,
hard-refresh (Ctrl+Shift+R): the asset hashes changed and the cached
`index.html` still points at files that are gone.

## When Docker itself wedges

Kill the Docker processes, `wsl --shutdown`, relaunch Docker Desktop, then
re-run `check-stack.ps1`. This has been needed more than once.
