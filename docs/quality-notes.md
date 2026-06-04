# Stream C — Working Notes

> Scratchpad for the quality stream. Not user-facing; will be removed before the
> final PR (or kept as an internal QA log — decide at PR time).

## Baseline coverage (2026-06-04, before new tests)

Measured with `pnpm vitest run --coverage` (root config: services + packages only;
apps run under their own jsdom configs and were not yet coverage-instrumented).

| Area                    | Lines                         | Target |
| ----------------------- | ----------------------------- | ------ |
| services/ai-gateway     | **71.85%** (610/849)          | 70% ✅ |
| services/socket-gateway | **16.07%** (98/610)           | 70% ❌ |
| services/workers        | **38.08%** (425/1116)         | 70% ❌ |
| apps/agent-portal       | not measured (0 instrumented) | 60%    |
| apps/admin-portal       | not measured                  | 60%    |
| packages/shared-types   | 97.62%                        | —      |

Existing: 130 passing unit tests across 15 files.

### Biggest 0% gaps to attack

- socket-gateway: `connection.ts` (353 lines), `directus.ts` (144), `queue.ts` (72), `auth/agent-jwt.ts`
- workers: `reports.ts` (6%), `processors/ai.ts` (0%), `processors/directus-repos.ts` (0%), `mail/index.ts` (0%), `imports.ts` (50%)
- ai-gateway: `directus/index.ts` (0%), `provider/gemini.ts` (0%) — already over target overall

Bootstrap `index.ts` files (server wiring) are intentionally low-value to unit test;
exclude from coverage denominator rather than chase them.

## Final coverage (after new tests)

| Area                    | Lines                         | Target | Tests               |
| ----------------------- | ----------------------------- | ------ | ------------------- |
| services/socket-gateway | **82%**                       | 70% ✅ | —                   |
| services/workers        | **77%**                       | 70% ✅ | —                   |
| services/ai-gateway     | **81%**                       | 70% ✅ | 211 (services+pkgs) |
| apps/agent-portal       | **65.2%** (br 71.7 / fn 70.4) | 60% ✅ | 96                  |
| apps/admin-portal       | **76.2%** (br 72.5 / fn 57.1) | 60% ✅ | 71                  |

Thresholds enforced: services via root `vitest.config.ts` per-service globs (70%);
apps via per-app `vitest.config.ts` (lines 60 / branches 70 / functions 55).
Apps use a single-fork pool + `afterEach(cleanup)` so the whole suite runs in one
memory-frugal process without DOM bleed.

## Environment notes

- chat-widget `vitest run` fails locally on Windows (broken `@preact/preset-vite`
  symlink: POSIX target path). Linux CI resolves it fine; chat-widget has no unit
  tests (e2e only). Not a real regression.
- Added devDeps (root): `@vitest/coverage-v8@2.1.9`, `husky@^9.1.7`, `lint-staged@^15.2.11`.
  Lockfile changed — flag in PR per shared-territory rule.
