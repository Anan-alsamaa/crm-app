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

| Branch                    | Folder                          | Slot | Scope                                                                                           |
| ------------------------- | ------------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `feat/new-complaint-form` | `crm-app-wt/new-complaint-form` | 1    | Ticket form reshaped to the operations manager's New Complaint layout, plus the nine new fields |
| `feat/inbox-order-link`   | `crm-app-wt/inbox-order-link`   | 2    | Clicking the order id in the inbox opens the ticket page                                        |
| `feat/top-nav`            | `crm-app-wt/top-nav`            | 3    | Sidebar navigation moved to a top bar                                                           |
| `feat/complaints-import`  | `crm-app-wt/complaints-import`  | 4    | Repeatable Restaurants CSV upload — insert new rows, skip existing, never overwrite             |
| `feat/store-csat`         | `crm-app-wt/store-csat`         | 5    | Branch-level satisfaction from the customer's post-chat rating                                  |

These four were chosen because they barely overlap in the files they touch. Two
sessions both editing the ticket form would still collide at merge time — the
worktree prevents clobbering, not conflicting intent.

## Finish one

```powershell
pnpm verify                                   # in the worktree — the gate
git -C <main repo> merge --no-ff feat/<name>
git -C <main repo> worktree remove ../crm-app-wt/<name>
git -C <main repo> branch -d feat/<name>
```

Rebase on `main` before merging if `main` has moved:
`git -C ../crm-app-wt/<name> rebase main`.
