# Stream B — Frontend / UX Polish

You are the Claude session for this worktree. Read this brief first, then
start work without further confirmation.

## Where you are

- **Worktree**: `D:\emad\Afcoapp\ProgramFile\claudeCode\crm-app-frontend`
- **Branch**: `stream/frontend` (off `001-yiji-crm-platform`)
- **Integration branch**: `001-yiji-crm-platform`
- **Coordination doc**: [specs/001-yiji-crm-platform/parallel-work-plan.md](./specs/001-yiji-crm-platform/parallel-work-plan.md) — read this before doing anything else.

## What you own — only edit these paths

- `apps/**` (agent-portal, admin-portal, chat-widget)
- `packages/ui/**`
- `packages/i18n/**`

## What you must NOT edit (other streams own these)

- `services/**` — Stream A
- `directus/**` — Stream A
- Any `Dockerfile`, `docker-compose*.yml`, `.github/workflows/deploy*.yml` — Stream A
- `docs/PRODUCTION.md` — Stream A
- `**/tests/**` outside `apps/**/tests` — Stream C
- `.github/workflows/ci.yml`, `vitest.config.ts`, `playwright.config.ts`, root `package.json` scripts, `.husky/**` — Stream C
- `docs/**` except files inside `apps/**` (none expected) — Stream C
- `README.md` — Stream C

## Shared territory — escalate before touching

`packages/shared-types/**`, `packages/shared-config/**`, `pnpm-workspace.yaml`,
`pnpm-lock.yaml`: land changes on `001-yiji-crm-platform` first, then rebase.

## Your work

The 12 concrete tasks are in
[specs/001-yiji-crm-platform/parallel-work-plan.md](./specs/001-yiji-crm-platform/parallel-work-plan.md)
under "Stream B". Read them, then start at #1. Roughly:

1. Mobile responsive agent portal (drawer at sm, single-column conversation view)
2. Mobile responsive admin portal
3. Loading skeletons across every fetching page
4. Designed empty states for every list view
5. Route-level error boundaries with retry
6. Unified toast notifications across both portals
7. Axe accessibility audit + fix every violation
8. Lighthouse: agent-portal first-load < 2s / < 200KB initial JS gzipped
9. i18n completeness — every string via `t()`, EN+AR keys exist, RTL passes
10. Polish recent presence/notes work (sidebar internal-notes section, status pill)
11. Keyboard nav + `?` shortcut overlay
12. Coordinate with Stream C on visual-regression Playwright screenshots

## Done criteria

Stop when:
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` are all green.
- Both portals render cleanly on iPhone 14 viewport (375×812) and desktop.
- Axe reports zero serious/critical violations on every route in the existing E2E setup.
- Lighthouse hits the budget on agent-portal home (signed in).
- A native AR speaker (or your best simulation) reads the portals end-to-end without finding hardcoded English strings.
- PR opened into `001-yiji-crm-platform`.

## Workflow

```powershell
git fetch origin
git rebase origin/001-yiji-crm-platform

# Iterate. Push often:
git push -u origin stream/frontend

gh pr create --base 001-yiji-crm-platform --head stream/frontend
```

## Pinned constraints

- **No services or infra changes from this branch.** If a frontend bug
  has a backend cause, file it for Stream A on `001-yiji-crm-platform`
  (or open an issue) — don't fix it here.
- **No new shared types.** Land them on `001-yiji-crm-platform` first.
- **No silent translation fallbacks**: if a key is missing from `ar.json`,
  add it. No `defaultValue:` shrugs.
- **Don't disable accessibility lint rules** to "make it pass". Fix the
  underlying HTML.
- **No commits to `001-yiji-crm-platform`** directly. Only PRs.

## First commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @yiji/agent-portal dev   # spin it up to look around before editing
```

When the baseline is clean, read `parallel-work-plan.md` task #1 and start.
