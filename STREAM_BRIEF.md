# Stream C — Quality / Docs / DX

You are the Claude session for this worktree. Read this brief first, then
start work without further confirmation.

## Where you are

- **Worktree**: `D:\emad\Afcoapp\ProgramFile\claudeCode\crm-app-quality`
- **Branch**: `stream/quality` (off `001-yiji-crm-platform`)
- **Integration branch**: `001-yiji-crm-platform`
- **Coordination doc**: [specs/001-yiji-crm-platform/parallel-work-plan.md](./specs/001-yiji-crm-platform/parallel-work-plan.md) — read this before doing anything else.

## What you own — only edit these paths

- `**/tests/**` (add tests anywhere — the test files are yours; the
  source files they test are not — see below)
- `.github/workflows/ci.yml`
- `vitest.config.ts`, per-package `vitest.config.*`
- `playwright.config.ts`
- `.eslintrc*`, `.prettierrc*`
- `.husky/**` (create it; doesn't exist yet)
- `docs/**` except `docs/PRODUCTION.md`
- `README.md`
- root `package.json` scripts (the `"scripts"` section — careful, don't change deps)
- `skills/**`

## What you must NOT edit (other streams own these)

- `services/**`, `directus/**` — Stream A
- `apps/**`, `packages/ui/**`, `packages/i18n/**` — Stream B
- Any `Dockerfile`, `docker-compose*.yml`, `.github/workflows/deploy*.yml` — Stream A
- `docs/PRODUCTION.md` — Stream A

**Tests are yours, but the code they test isn't.** If a test reveals a
bug in someone else's territory, file it for the owning stream (commit on
`001-yiji-crm-platform`, or open an issue) — don't fix it here. The
exception: if a test fix requires a one-line change to make a function
exportable, coordinate with the owning stream first.

## Shared territory — escalate before touching

`packages/shared-types/**`, `packages/shared-config/**`, `pnpm-workspace.yaml`,
`pnpm-lock.yaml`: land changes on `001-yiji-crm-platform` first, then rebase.

## Your work

The 12 concrete tasks are in
[specs/001-yiji-crm-platform/parallel-work-plan.md](./specs/001-yiji-crm-platform/parallel-work-plan.md)
under "Stream C". Read them, then start at #1. Roughly:

1. Coverage targets — 70% services, 60% apps. Start by measuring with `pnpm vitest --coverage`.
2. Critical-path Vitest:
   - socket-gateway connection events (mocked Directus)
   - workers: each queue processor, happy + failure
   - ai-gateway: every endpoint × cache hit/miss × rate-limited/not
   - agent-portal: `features/inbox/api.ts`, mentions, custom-field, AI panel
   - admin-portal: at least one render test per feature page
3. Critical-path Playwright E2E for the marquee flows.
4. CI < 12 min — cache Playwright browsers, pnpm store, parallelize quality vs E2E.
5. `husky` + `lint-staged`: pre-commit prettier + eslint on staged files.
6. Coverage upload (Codecov or CI summary).
7. `docs/ARCHITECTURE.md` — the as-built shape, not the spec aspirations.
8. `docs/USER_GUIDE_AGENT.md`.
9. `docs/USER_GUIDE_ADMIN.md`.
10. Rewrite `README.md` for the current state.
11. Storybook for `packages/ui` (optional, only if time permits).
12. `.github/CODEOWNERS`.

## Done criteria

Stop when:

- CI under 12 min on every push.
- Coverage thresholds enforced in CI (build fails on regression).
- `husky` pre-commit prevents the format-drift class of bugs we hit earlier.
- The three user-facing docs (agent guide, admin guide, architecture) read
  cleanly without referencing planning artifacts.
- PR opened into `001-yiji-crm-platform`.

## Workflow

```powershell
git fetch origin
git rebase origin/001-yiji-crm-platform

git push -u origin stream/quality

gh pr create --base 001-yiji-crm-platform --head stream/quality
```

## Pinned constraints

- **Tests must be deterministic.** No `Math.random()`, no real `Date.now()`
  without injection. The codebase has a no-`Date.now`-in-workflow-scripts
  rule for the same reason — apply that spirit here.
- **No production code edits.** Mocking / adapters / fixtures go in `tests/`.
- **CI changes that risk lengthening runtime need a measurement** before
  merging. Comment the before/after wall-clock in the PR body.
- **Pre-commit hooks**: when you wire husky, make sure they don't run the
  full test suite — only prettier + eslint on staged files. We want fast.
- **No commits to `001-yiji-crm-platform`** directly. Only PRs.

## First commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm vitest --coverage   # baseline measurement before you start adding tests
```

When the baseline is captured (paste the coverage % into a working notes
file), read `parallel-work-plan.md` task #1 and start.
