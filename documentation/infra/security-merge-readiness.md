# Security Fix — Merge Readiness into `001-yiji-crm-platform`

> **Date:** 2026-06-24 · **Status:** READY (gates green for the changed code) · **NOT merged**, per instruction.
> **Merge candidate:** `fix/socket-idor-typing-read-phase2` @ **`73717ea`** (cumulative — contains Phase 1 + Phase 2).
> **Target / base:** `origin/001-yiji-crm-platform` @ **`ef31b01`**.

---

## 1. Rebase result

- `git fetch origin --prune` → `origin/001-yiji-crm-platform` is at **`ef31b01`**, which is **exactly the branch's base**.
- `git rebase origin/001-yiji-crm-platform` → **"Current branch is up to date"** — a **no-op**. The branch already sits on top of the latest `001`.
- **Conflicts: none.** Verified `001` has had **zero** commits since `ef31b01`, and no upstream change touches the files this branch edits (`git diff --name-only ef31b01 origin/001 -- …/connection.ts …/connection.test.ts` → empty).
- Pre-rebase HEAD (recovery reference, unchanged): `73717ea`.

---

## 2. What is being merged

Cumulative remediation of the `989da1f → ef31b01` security regression (root cause: merge `ecd655c`/PR #29 overwrote `connection.ts` with a frontend-stream copy). Closes **5 of 7** convergence-audit findings:

| Commit              | Finding(s)                                                                                  | Severity                |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------- |
| `dafbba7` (Phase 1) | #1 `message:send` IDOR guard · #4 `sanitizeFilename` usage · #6 `decodeUploadContent` usage | CRITICAL + MEDIUM + LOW |
| `73717ea` (Phase 2) | #2 `typing:*` IDOR guard · #3 `read:ack` IDOR guard                                         | MEDIUM + MEDIUM         |

**Still OPEN (intentionally excluded — need a human decision, not a code restore):**

- **#5** `WIDGET_CORS_ORIGIN='*'` exempt from the prod no-wildcard guard (product decision: documented `*` exception vs prod allow-list).
- **#7** customer-jwt identifier narrowed phone-OR-email → phone-only (likely intentional; needs confirmation).

---

## 3. Exact files changed (vs base `ef31b01`)

```
documentation/security-regression-remediation.md   (Phase 1 report)
documentation/security-remediation-phase2.md        (Phase 2 report)
services/socket-gateway/src/connection.ts           (message:send + typing + read IDOR guards; sanitizeFilename + decodeUploadContent usage)
services/socket-gateway/tests/connection.test.ts    (IDOR + own-conversation regression tests + helpers)
```

**No code outside `services/socket-gateway/` is touched** — no `packages/`, no `apps/`, no other service. Confirmed via `git diff --name-only ef31b01 73717ea`.

---

## 4. Gate results

Run from the `crm-app-infra` worktree at HEAD `73717ea`.

| Gate                            | Command                                               | Result                                                                                             |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Lint**                        | `pnpm lint` (`eslint . --ext .ts,.tsx`)               | ✅ **PASS** (exit 0)                                                                               |
| **Typecheck (changed pkg)**     | `pnpm exec tsc --noEmit` in `services/socket-gateway` | ✅ **PASS** (exit 0)                                                                               |
| **Typecheck (repo-wide)**       | `pnpm typecheck` (`pnpm -r typecheck`)                | ⚠️ **1 pre-existing env failure in `packages/ui`** — see note below; **not caused by this branch** |
| **Tests (services + packages)** | `pnpm exec vitest run`                                | ✅ **PASS** — **35 files / 291 tests** (exit 0)                                                    |
| **Tests (changed pkg)**         | `pnpm exec vitest run services/socket-gateway`        | ✅ **PASS** — **14 files / 121 tests** (`connection.test.ts` = 26)                                 |

### Note on the `packages/ui` typecheck failure (pre-existing, environmental — NOT a blocker)

- Errors are all **missing type declarations**: `Cannot find module '@storybook/react'` and `Could not find a declaration file for module 'react-dom'` across `*.stories.tsx` / `SelectMenu.tsx`.
- Root cause: **`@storybook/react` and `@types/react-dom` are not installed in this worktree's `node_modules`** (verified absent). A devDependency-install gap specific to the local infra worktree, not a code defect.
- **Provably not introduced by this branch:** `git diff --stat ef31b01 73717ea -- packages/` is **empty** — `packages/ui` is byte-identical to base, so it fails identically on `001` itself. CI on Linux (full `pnpm install`) compiles `packages/ui` normally; the frontend-stream verification (`frontend-audit.md`) recorded typecheck + 343 unit tests green there.

### Mutation-test evidence (test quality)

The new IDOR tests were verified to be **non-vacuous**: temporarily removing the typing guard makes `typing:start ... is dropped (IDOR)` **fail** (`unexpected typing:update received`); the read and message:send IDOR tests follow the same pattern. Guard restored, full suite green.

---

## 5. Risk assessment

- **Blast radius:** minimal — one source file (`connection.ts`) in one service; changes are **additive authorization guards** (each a single early-`return`) plus their restored helper call-sites. No control flow for the happy path changed; positive-control tests (same-conversation typing/read, own-conversation message persist) remain green, proving no over-blocking.
- **Behavior change:** customer events targeting a foreign `conversationId` are now dropped — this is the **intended** security tightening (restoring `989da1f`). Legitimate same-conversation traffic is unaffected.
- **No schema/contract/dependency changes**, no env/config changes, no migration. Reversible by revert.
- **Confidence:** HIGH. Gates green for all changed and adjacent code; the only red is a pre-existing, unrelated, environmental typecheck gap.

---

## 6. Recommended merge plan (execute only when you approve)

1. Open a PR: `fix/socket-idor-typing-read-phase2` → `001-yiji-crm-platform`. (Branch is local-only; push first.)
2. Let CI run the full Linux gates (where `packages/ui` typecheck passes) — expect green.
3. Merge style: **merge commit** (repo convention, e.g. PRs #29/#30/#33). Title suggestion: _"security: restore socket-gateway IDOR/upload hardening dropped by ecd655c (audit #1–#4,#6)."_
4. Track **#5** and **#7** as separate follow-up issues (decisions, not restores).
5. After merge, note the running deployment serves from `main`, not `001` (see `current-runtime-state.md`) — the fix won't be live until that's reconciled / rebuilt.

> **Do not merge yet** — this document is the readiness gate only. Nothing was pushed or merged.

---

### Verification trail

`git fetch`; `git rebase origin/001-yiji-crm-platform` (no-op); `git diff --name-only ef31b01 73717ea`; `pnpm lint`; `pnpm typecheck`; `pnpm exec vitest run`; `pnpm exec vitest run services/socket-gateway`; devDep presence checks for the `packages/ui` diagnosis. Read-only except this report; branch HEAD unchanged at `73717ea`.
