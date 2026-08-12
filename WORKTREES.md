# Parallel sessions with git worktrees

Several features are built at once, each in its own Claude Code session. Two
sessions sharing one working tree overwrite each other's files and produce
tangled commits, so each session gets a **worktree**: a full checkout on its own
branch, in its own folder, sharing one `.git`.

## Create one

```powershell
./scripts/new-worktree.ps1 -Name <feature> -Slot <1-9>
```

Then open a new Claude Code session with `../crm-app-wt/<feature>` as its
working directory. The script copies the gitignored `.env` files, runs
`pnpm install`, and prints the dev-server ports for that slot.

## What is shared and what is not

|                                                    | Shared  | Why                                                                                                |
| -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| Postgres, Redis, Directus, gateway, workers, nginx | **yes** | One database. Do not start a second copy — the ports are already taken and the data would diverge. |
| `.git` (history, branches, tags)                   | **yes** | That is what makes it a worktree.                                                                  |
| Working files, `node_modules`, `dist`              | no      | Per worktree. This is the isolation.                                                               |
| Vite dev servers                                   | no      | Each slot gets its own ports (slot 1 → 5183/5184/5185).                                            |

Because Directus is shared, a **schema or bootstrap change in one worktree is
visible to all of them.** Only one session at a time should touch
`directus/bootstrap` or the seeders.

## Current worktrees

| Branch                        | Folder                        | Slot | Scope                                                                        |
| ----------------------------- | ----------------------------- | ---- | ---------------------------------------------------------------------------- |
| `feat/inbox-panel-and-status` | `crm-app-wt/inbox-order-link` | 2    | Inbox details-panel order, and conversation status reduced to solved/pending |
| `feat/top-nav`                | `crm-app-wt/top-nav`          | 3    | Sidebar navigation moved to a top bar                                        |
| `feat/store-csat`             | `crm-app-wt/store-csat`       | 5    | Branch-level satisfaction from the customer's post-chat rating               |

These were chosen because they barely overlap in the files they touch. Two
sessions both editing the ticket form would still collide at merge time — the
worktree prevents clobbering, not conflicting intent.

Slot 1 (`feat/new-complaint-form`) is closed: the complaint form and the
operations manager's dashboard are merged. It also left two fixes worth knowing
about, because both were silent failures rather than errors:

- `docker compose` published Postgres on **5433**, a port this machine's native
  PostgreSQL 15 already owns, so the binding was shadowed — host connections
  reached the wrong server and succeeded. The bootstrap's raw-SQL step wrote
  this schema's indexes into an unrelated database for as long as it had been
  set up that way. Postgres is now on `127.0.0.1:${DB_PORT_EXTERNAL:-5434}`, and
  `apply` refuses to run raw SQL until the connection proves it is the database
  behind Directus.
- The gitignored `docker-compose.override.yml` pins `postgres:17-alpine` and
  that pin is load-bearing: the data volume is PG17 and the committed compose
  file still says `16-alpine`, so bringing the stack up without the override
  makes Postgres refuse to start on newer data files.

## Finish one

```powershell
pnpm verify                                   # in the worktree — the gate
git -C <main repo> merge --no-ff feat/<name>
git -C <main repo> worktree remove ../crm-app-wt/<name>
git -C <main repo> branch -d feat/<name>
```

Rebase on `main` before merging if `main` has moved:
`git -C ../crm-app-wt/<name> rebase main`.
