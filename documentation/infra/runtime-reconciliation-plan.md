# Runtime Reconciliation Plan — `main` vs `001-yiji-crm-platform`

> **Date:** 2026-06-24 · **Type:** analysis + plan only. **No code modified.**
> **Goal:** all runtime components originate from a **single** branch.
> **Refs compared:** `origin/main` vs `origin/001-yiji-crm-platform`. **Merge-base:** `066721a` (2026-06-23, "fix(widget): accessibility + WCAG AA contrast pass"). Divergence: **28 commits only in main · 16 only in 001.** The secure baseline `989da1f` is an **ancestor of both**.

---

## 0. Headline finding (read first)

The two branches have **diverged in BOTH directions**, and — counter to the documented model — **`main` is currently the more _secure_ branch, while `001` (the GitHub default / "source of truth") carries a CRITICAL regression and outdated dependencies:**

| Security control                                                    | `main`                    | `001 @ ef31b01`                                 |
| ------------------------------------------------------------------- | ------------------------- | ----------------------------------------------- |
| `connection.ts` customer IDOR guards (message:send / typing / read) | ✅ **present (4 guards)** | ❌ **only 1 (csat)** — regressed by `ecd655c`   |
| Dependabot patches (vitest 3.x, form-data/esbuild overrides)        | ✅ **patched**            | ❌ **vitest ^2.1.8, no overrides** (vulnerable) |
| ai-gateway C-2 hardening (commerce proxy + `verifyCaller`)          | ✅                        | ✅ (both)                                       |

Meanwhile **`001` has deploy/build infrastructure that `main` lacks** (Linux build script, Compose `app` profile, bootstrap idempotence). **Neither branch is a complete source of truth today.** And the running stack draws from **three** different branches at once (§4).

---

## 1. Commits only in `main` (28; key ones)

**Security / dependencies (must not be lost):**

- `9a9a6c2` fix(deps): patch dependabot vulns (vitest, nodemailer, form-data, esbuild) — **`001` lacks this.**
- The secure `connection.ts` (all 4 IDOR guards) — inherited from `989da1f` and **never regressed on main** (main predates `ecd655c`).
- `e41e9f6` fix(agent): fetch attachments via the SDK so H-2 cookie-auth refresh applies.

**Operational tooling (main-only):**

- `b3b4dc5` feat(ops): Claude-driven incident response · `97e04fc` operational remediation lane · `a47f660` unattended-capable permissions · `d1f210d` refactor(ops): one chat-driven rule. (`001`'s CLAUDE.md has **none** of this.)

**Deploy / docs:**

- `9559a87` + `e8c1c56` no-cache SPA shell (edge + portal) · `89c3360` align ecosystem.config.cjs to hybrid · `c66a479` prod compose boots · `c921e2d` DIRECTUS_INTERNAL_URL · `d417271` + `7f26ca2` hybrid runbook docs · `409e50b` retire superseded docs · `2b2d86d` gitignore rehearsal artifacts · `60e02a5` test assertion updates.

> Several deploy fixes (e.g. no-cache SPA) **also** exist in `001` under different SHAs (cherry-picked via PR #30 → `1872764`/`3cedb4b`), so they are content-equivalent, not unique risk.

## 2. Commits only in `001` (16; key ones)

**Deploy / build infrastructure (main lacks these):**

- `fd8c21c` (PR #31) deploy: Linux single-repo frontend build (`deploy/build-frontend.sh`) — **main lacks the script.**
- `93c1358` (PR #33) fix(infra): gate app services behind a Compose `app` profile — **main's `docker-compose.yml` has no profiles.**
- `3cedb4b` no-cache SPA in container images · `1872764` no-cache edge nginx (PR #30).
- bootstrap idempotence (PR #28) · `80a58cf` (PR #32) e2e selector fix.

**Integration history & the regression source:**

- `ecd655c` (PR #29) "converge frontend stream" — **the merge that dropped the IDOR guards** · `b2e503e` (PR #26) security hardening C-1/C-2/H-\* · `435702a` (PR #27) deploy arch · `d87e9c0` prettier drift.

> The CRITICAL security regression lives **only on `001`**, introduced by `ecd655c`. It is already remediated on the un-merged branch **`fix/socket-idor-typing-read-phase2`** (Phase 1+2: findings #1–#4, #6).

---

## 3. Which branch should be the deployment source of truth?

**Recommendation: `001-yiji-crm-platform`** — but **only after** its two security gaps vs `main` are closed (they are closeable; see §4 Phase A).

**Why `001` (not `main`):**

1. It is the **GitHub default branch** and the **integration target for every PR** (CLAUDE.md names `001` the active feature). The whole team's workflow already converges here.
2. It is the only branch with the **deploy/build tooling a production cutover needs** — the Linux `build-frontend.sh`, the Compose `app` profile (hybrid-safe `up`), bootstrap idempotence, and container-image cache headers. `main` cannot be deployed with the documented runbook because it **lacks these**.
3. Its security deficits relative to `main` are **finite and already mostly solved**: the IDOR regression is fixed on the ready-to-merge branch, and the dependabot patch is a single cherry-pick from `main`.

**Why not `main`** (despite being more secure today): adopting `main` as the deploy source would require porting `001`'s entire deploy/build infrastructure and PR-integration history _backward_ into `main` — more work, and it contradicts the established default-branch model. `main`'s genuine advantages (secure `connection.ts`, dependabot, ops lane) are **easier to pull _into_ `001`** than `001`'s deploy stack is to pull into `main`.

**Net:** converge **into `001`**, making it a superset of both, then deploy everything from it.

---

## 4. Exact actions to make runtime match the source of truth

### Phase A — Make `001` complete & secure (close the gaps vs `main`)

> All are code/repo changes — listed as the plan; **not executed here**.

1. **Merge the security fix branch** `fix/socket-idor-typing-read-phase2` → `001` (restores the 4 IDOR guards + sanitizeFilename/decodeUploadContent). Readiness already verified in `security-merge-readiness.md` (rebase no-op, lint green, 291 tests green).
2. **Port `main`'s dependabot patches** into `001`: cherry-pick `9a9a6c2` (or re-apply: bump `vitest`/`@vitest/coverage-v8` to ^3.2.6, add the `form-data`/`esbuild` pnpm `overrides`), then `pnpm install` to regenerate `pnpm-lock.yaml`. Expect a lockfile conflict to resolve.
3. **Port `main`'s operational lane + agent fix** into `001` (if wanted as part of the canonical branch): cherry-pick `b3b4dc5`, `97e04fc`, `a47f660`, `d1f210d` (CLAUDE.md ops rule + permissions) and `e41e9f6` (agent attachment SDK cookie-auth fix — verify whether `001` already has equivalent content first).
4. **Do NOT do a blind `git merge main → 001`.** A 3-way merge would **not** restore the IDOR guards (the merge-base already had them; `001` deleted them, `main` left them unchanged → git keeps `001`'s deletion). It would also collide on `connection.ts`, which `ecd655c` rewrote. Use the targeted fix branch (step 1) + cherry-picks (steps 2–3) instead.
5. Re-run gates on the converged `001`: `pnpm lint`, `pnpm typecheck`, `pnpm exec vitest run`. (Note the pre-existing `packages/ui` typecheck env-gap from `security-merge-readiness.md` — install `@storybook/react`/`@types/react-dom` or accept it as CI-only-green.)

### Phase B — Re-point every runtime component to `001`

Current runtime sources (verified in `current-runtime-state.md`) and the target:

| Component                                                             | Currently runs from                                                | Action to source from `001`                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PM2 services** (socket-gateway 8080/8081, ai-gateway 8085, workers) | `crm-app` worktree @ **`main`**                                    | Point PM2 at a `001` checkout: either `git -C crm-app checkout 001-yiji-crm-platform` (then `pm2 restart all`), **or** run `ecosystem.config.cjs` from the `crm-app-infra` worktree (already on `001`). Confirm `pm2 jlist` cwd → a `001` tree. |
| **nginx portals** (`yiji-portals` → 8090/8092)                        | `crm-app/apps/*/dist` built from **`main`** (06-23)                | Rebuild from `001`: run `deploy/build-frontend.sh` (or `pnpm --filter @yiji/{agent,admin}-portal build`) in a `001` worktree, and point the `yiji-portals` bind-mounts at that worktree's `apps/*/dist`.                                        |
| **Chat widget** (Vite 5175 → ngrok)                                   | `crm-app-frontend` worktree @ **`fix/e2e-tickets-first-response`** | Run the widget dev server (or a built bundle) from a `001` worktree; retire the `fix/e2e-…` source. Re-point ngrok to that 5175.                                                                                                                |
| **Docker infra** (postgres/redis/directus compose)                    | `crm-app-infra` worktree @ **`001`**                               | Already on `001` — **no change** (and these are official images, branch-independent anyway).                                                                                                                                                    |

**Simplest topology:** designate **one** `001` worktree as the runtime home (e.g. `crm-app-infra`, already on `001`), and drive PM2 + portal builds + widget from it, so a single `git pull` updates everything. Retire the `main` and `fix/e2e` runtime roles.

### Phase C — Verify single-source

1. Confirm all four components trace to the same `001` HEAD: `pm2 jlist` cwd, the `dist` build provenance, the widget process cwd, and the compose config path all resolve to the `001` worktree.
2. Smoke test: Directus `200`, gateway `200`, ai-gateway `200`, portals `200`, widget via ngrok `200` (per `current-runtime-state.md` probes).
3. Rebuild portal `dist` **after** Phase A so the served bundle reflects the converged `001` HEAD (avoids the stale-build gap noted in the runtime audit).

---

## 5. Risks & notes

- **Concurrent session:** another agent has been mutating these branches/worktrees this session — re-verify `origin/main` and `origin/001` HEADs immediately before executing any step.
- **Lockfile conflict** is expected when porting the dependabot patch (step A2); regenerate via `pnpm install`, don't hand-merge.
- **`connection.ts` divergence:** `main`'s and `001`'s versions differ structurally (the `ecd655c` rewrite). Keep `001`'s structure + the fix-branch guards; do not overwrite with `main`'s file wholesale (would lose `001`-side frontend-stream changes).
- **Deployment currency:** even after Phase A merges, the live stack stays on `main`/`fix-e2e` until Phase B is executed — the fix is not "live" on merge alone.
- **Do not merge / deploy from this document** — it is the plan only.

---

### Verification trail

`git fetch`; `git rev-list --left-right --count`; `git log origin/main ^origin/001` and inverse; `git merge-base`; `git merge-base --is-ancestor 989da1f <branch>`; `git show <branch>:services/socket-gateway/src/connection.ts | grep` (guard counts: main=4, 001=1); `git show <branch>:package.json` (vitest/form-data/esbuild pins); `git show <branch>:CLAUDE.md` (ops lane); `git cat-file -e <branch>:deploy/build-frontend.sh` and compose `profiles:` check. Cross-referenced with `current-runtime-state.md` and `security-merge-readiness.md`. Read-only.
