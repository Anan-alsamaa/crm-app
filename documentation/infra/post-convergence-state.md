# Post-Convergence State

> **Date:** 2026-06-24 · **Outcome:** the security + deploy convergence is **merged and pushed to `origin/main`**; the typing/read IDOR tests are ported. **Nothing deployed.**

---

## Tasks completed

| #   | Task                         | Result                                                                       |
| --- | ---------------------------- | ---------------------------------------------------------------------------- |
| 1   | Push `757f5e0`               | ✅ published on branch `convergence/security-deploy-into-main`               |
| 2   | Open PR                      | ✅ **PR #35** (base `main`)                                                  |
| 3   | Merge into main after review | ✅ all CI checks green → **merged** (merge commit `c0a67f3`); branch deleted |
| 4   | Port typing/read IDOR tests  | ✅ commit `60f2581` on `main` (pushed)                                       |
| 5   | This document                | ✅                                                                           |

CI on PR #35 (all green): Lint/typecheck/unit tests (incl. the new **security call-site guard** step), Validate compose files, AI/commerce auth contract (C-1/C-2), Bootstrap idempotence. Playwright E2E skipped (workflow_dispatch-only by design).

---

## 1. Final branch status

- **`origin/main` = `60f2581`** (local `main` in sync). History tip:
  `… d1f210d → 92bd034 (Linux build) → bb16e41 (Compose app profile) → 757f5e0 (decodeUploadContent + CI guard) → c0a67f3 (merge PR #35) → 60f2581 (typing/read IDOR tests)`.
- **`main` is the single authoritative, deployable branch.**
- **GitHub default branch is still `001-yiji-crm-platform` @ `ef31b01`** — now **33 commits behind `main`** and missing the security guards + dependabot patches. (See Open Decisions.)

## 2. Security status

| Control                                                      | `main` @ `60f2581`                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Customer IDOR guards (message:send, typing, read, csat)      | ✅ all 4 present                                                     |
| typing/read IDOR **regression tests**                        | ✅ ported (connection.test.ts: 26 tests; vitest **291** total)       |
| `sanitizeFilename` (path/RLO defense) used                   | ✅                                                                   |
| `decodeUploadContent` (buffer-slice integrity) used          | ✅ restored                                                          |
| Dependabot patches (vitest 3.x, form-data/esbuild overrides) | ✅                                                                   |
| ai-gateway C-2 (server-side commerce key, `verifyCaller`)    | ✅                                                                   |
| **CI guard** — fail on exported-but-uncalled security helper | ✅ added + proven non-vacuous (passes; exits 1 when decode reverted) |

All seven convergence-audit findings are now resolved or decisioned on `main`: #1–#4, #6 fixed; #2/#3 also test-covered; #5/#7 are Open Decisions (below).

> ⚠️ The GitHub Dependabot alert (16 vulns: 5 critical / 4 high / 6 moderate / 1 low) is reported against the **default branch `001`**, which lacks `main`'s dependency patches. `main` is patched. Resolving the alert requires realigning `001` (or switching the default) — see Open Decisions.

## 3. Runtime status

**The new `main` code is NOT live** (correct — not deployed):

- **PM2** services (`socket-gateway`, `ai-gateway`, `workers`) are the **same processes from before convergence** — uptime ~331 min, unchanged PIDs (27688 / 19956 / 26552), running `tsx` from the `crm-app` worktree. They have **not** reloaded the new `connection.ts` (decodeUploadContent / typing-read changes don't affect already-running code until restart).
- **nginx portals** (`yiji-portals` :8090/:8092) still serve `dist` built **2026-06-23** — stale relative to `main` HEAD.
- **Widget** still served by Vite :5175 from the **`crm-app-frontend` worktree (`fix/e2e-tickets-first-response`)**, not `main`.
- **Docker infra** (postgres/redis/directus) unchanged.

So runtime is unchanged from `current-runtime-state.md`: a multi-branch mix (PM2←main _worktree_ but pre-convergence code, widget←fix/e2e, compose←001 worktree). Bringing runtime onto `main @ 60f2581` is a deploy action (out of scope here).

## 4. Known open decisions

1. **GitHub default branch / `001` realignment.** `main` is the authoritative branch but `001` is still the GitHub default (33 commits behind, carries the 16 Dependabot vulns + the IDOR regression). Decide: (a) switch default to `main`, and/or (b) merge `main → 001` to bring `001` up to parity. Until then, the default branch is insecure and any process targeting `001` inherits that.
2. **`WIDGET_CORS_ORIGIN` (audit #5, MEDIUM).** Keep `*` for the widget socket (JWT is the auth boundary) but make it **explicit/fail-closed in production** rather than a silent default; document the rationale. Owner: security/product. _(Recommended in `convergence-final-remediation.md` §D.1; not implemented.)_
3. **customer-jwt phone-only (audit #7, LOW).** Signature verification is unchanged (no auth weakening); the phone-only identifier is a deliberate product narrowing. **Confirm with product → most likely ACCEPT + document.** Owner: product. _(Recommended §D.2; not implemented.)_

## 5. Deployment blockers

> "Blocker" = must be resolved before runtime can be a single-branch, current, secure deployment. None block the _code_; they are operational/governance.

1. **Runtime not rebuilt/restarted from `main`.** To go live on `60f2581`: `pm2 restart` the 3 services from a `main` worktree, rebuild `apps/{agent,admin}-portal/dist` (e.g. `deploy/build-frontend.sh`) and point `yiji-portals` at them, and serve the widget from `main` (not `fix/e2e`). Until then the fixes are not live.
2. **Multi-branch runtime.** The widget is served from `fix/e2e-tickets-first-response`; single-source requires moving it (and all components) onto `main`.
3. **Default-branch divergence (governance).** `001` being the default while behind/insecure is a release-hygiene blocker — realign before treating `001` as a deploy source or merge target.
4. **(LOW, non-blocking) Open decisions #2/#3** should be closed before a production cutover, but neither blocks a staging deploy.

No code-level blockers remain on `main`: lint ✅, typecheck ✅ (11 pkgs), tests ✅ 291, CI ✅ (incl. the new guard).

---

### Verification trail

PR #35 created/merged via `gh` (checks watched to green); `git push origin main` for `60f2581`; `git log` for branch tips; `gh repo view` for default branch; `pm2 jlist` for runtime (unchanged PIDs/uptime). Local `main` == `origin/main` == `60f2581`. Nothing deployed.
