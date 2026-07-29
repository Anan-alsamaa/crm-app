# Main Convergence — Complete (Option A)

> **Date:** 2026-06-24 · **Goal:** converge everything into `main` and make `main` the authoritative branch.
> **Result:** ✅ Cherry-picks applied, gates green, verifications pass (with **one LOW known issue**). **Local only — not pushed, not deployed.**
> **Work location:** the `crm-app` worktree (where `main` is checked out). Pre-convergence `main` HEAD: `d1f210d`.

---

## 1. Commits applied

Cherry-picked onto `main` (clean, **no conflicts**):

| New SHA on main | Source    | Commit                                                                                                  |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `92bd034`       | `fd8c21c` | deploy: Linux single-repo frontend build (`deploy/build-frontend.sh`) + strip widget demo page (PR #31) |
| `bb16e41`       | `93c1358` | fix(infra): gate app services behind a Compose `app` profile (hybrid-safe `up`) (PR #33)                |

New `main` history: `d1f210d → 92bd034 → bb16e41`. Files added: `deploy/build-frontend.sh`, `start-infra.ps1`, `stop-infra.ps1`; modified: `docker-compose.yml`, `deploy/README.md`, `README.md`, `specs/.../quickstart.md`, `specs/.../demo-guide.md`.

> These were the **only** two content commits `main` lacked from `001` (per `branch-convergence-final.md`). `main` already had the IDOR guards, dependabot patches, all gateway features, bootstrap idempotence, no-cache SPA headers, and the e2e selector fix.

---

## 2. Validation results

Run in the `crm-app` worktree at HEAD `bb16e41`:

| Gate          | Command                                      | Result                                                                                                                           |
| ------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Install**   | `pnpm install --frozen-lockfile`             | ✅ lockfile up to date, "Already up to date"                                                                                     |
| **Lint**      | `pnpm lint` (`eslint . --ext .ts,.tsx`)      | ✅ **PASS** (exit 0)                                                                                                             |
| **Typecheck** | `pnpm typecheck` (`pnpm -r typecheck`)       | ✅ **PASS — all 11 packages** (incl. `packages/ui`; this worktree has the storybook/react-dom devDeps the infra worktree lacked) |
| **Tests**     | `pnpm exec vitest run` (services + packages) | ✅ **PASS — 35 files / 289 tests**                                                                                               |

---

## 3. Verifications (task 3)

| #   | Check                                  | Result               | Evidence                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | socket-gateway security guards present | ✅ **PASS**          | `connection.ts` has **4** customer IDOR guards: message:send (L284), typing (L471), read (L485), csat (L507)                                                                                                                                                                                                          |
| 2   | attachment hardening present           | ⚠️ **PARTIAL**       | `sanitizeFilename(data?.filename)` used (L345) ✅ — path-traversal/RLO defense. **`decodeUploadContent` NOT used** — see Known Issue #1 (LOW)                                                                                                                                                                         |
| 3   | dependabot fixes present               | ✅ **PASS**          | `vitest`/`@vitest/coverage-v8` `^3.2.6`; pnpm overrides `form-data@…: >=4.0.6`, `esbuild@…: >=0.28.1`                                                                                                                                                                                                                 |
| 4   | Linux build path works                 | ✅ **PASS (static)** | `deploy/build-frontend.sh` exists, executable, `bash -n` syntax OK; builds agent/admin/widget from repo root and deletes the widget demo host page from the bundle. (Full execution is Linux/CI-targeted; not run on this Windows box — pnpm builds were independently validated by typecheck + prior portal builds.) |
| 5   | Compose app profile works              | ✅ **PASS**          | `profiles: ['app']` on socket-gateway/workers/ai-gateway. `docker compose config --services` → `directus, postgres, redis` (infra only); `--profile app` → adds `ai-gateway, socket-gateway, workers`. Confirmed functional.                                                                                          |

---

## 4. Final branch status

- **`main` @ `bb16e41`** is now the content-authoritative superset: deploy/build tooling (Linux build + Compose profile) **+** the security set it already held (4 IDOR guards, `sanitizeFilename`, dependabot patches) **+** all gateway features + ops lane.
- **Local only.** `main` has **not** been pushed to `origin` (origin/main still `d1f210d`) and **nothing was deployed** (PM2/nginx/widget untouched; the cherry-picked files are deploy/compose/docs, which don't affect the running `tsx` services).
- The two source branches:
  - `001-yiji-crm-platform` @ `ef31b01` — now **behind** `main` on security (still missing the IDOR guards + dependabot). Default-branch realignment is a separate decision (see §5).
  - `fix/socket-idor-typing-read-phase2` @ `73717ea` — its security work is now redundant with `main` **except** the `decodeUploadContent` fix (Known Issue #1).

---

## 5. Remaining known issues

1. **(LOW — integrity) `decodeUploadContent` not on `main`.** `main`'s `attachment:upload` still uses the inline decode `Buffer.from((view).buffer)`, which ignores `byteOffset`/`byteLength` and can corrupt uploads delivered as a Socket.IO buffer slice. The hardened `decodeUploadContent` exists in `attachments.ts` but is **not called**. This fix lives only on `fix/socket-idor-typing-read-phase2` and was **not** part of the two deploy cherry-picks.
   - _Correction to `branch-convergence-final.md`:_ that report stated `main`'s `connection.ts` was identical to the fix branch (both 555 lines). They have the same line count and the same 4 guards + `sanitizeFilename`, but the **decode differs** — `main` inline, fix-branch `decodeUploadContent`. The security-critical controls (IDOR + filename) are present on `main`; only this LOW integrity fix is absent.
   - _Remedy (follow-up, out of this task's scope):_ a 4-line change in `connection.ts` to call `decodeUploadContent(data?.content)` (+ add it to the `./attachments.js` import). Do **not** cherry-pick `dafbba7` wholesale — it would conflict (main already has the guards/sanitizeFilename).
2. **(LOW — test coverage) typing/read IDOR regression tests absent on `main`.** `main` has the typing/read **guards**, and the message:send IDOR test (from the `989da1f` lineage), but not the dedicated typing/read regression tests added on the fix branch. Guards are present and effective; only the explicit tests for them are missing.
3. **`main` not pushed.** To make `main` authoritative on `origin`, a `git push origin main` is required — **held pending your approval** (not done; outward action during an active concurrent session).
4. **Default-branch divergence.** GitHub's default branch is still `001`, which is now behind `main`. Decide whether to (a) switch the default to `main`, or (b) realign `001` to `main` (merge `main → 001` — clean for the guards since the fix branch already brought `001`'s `connection.ts` to parity if merged first; otherwise resolve `connection.ts` taking `main`).
5. **Concurrent session** has been mutating worktrees/branches this session — re-verify HEADs before any push/merge.
6. **Linux build** full execution was not performed on this Windows host (Git-Bash PATH caveat); validated statically. Run it once on Linux/CI to confirm end-to-end.

---

## 6. Recommended next steps (not executed)

1. (Optional, LOW) Apply the `decodeUploadContent` follow-up to `main` to close Known Issue #1.
2. `git push origin main` to publish the authoritative branch (with approval).
3. Realign `001` / GitHub default to `main` (Known Issue #4).
4. Only then plan deployment (re-point PM2 + portal builds + widget to `main`) — **explicitly out of scope here; do not deploy yet.**

---

### Verification trail

`git cherry-pick fd8c21c 93c1358` (both clean); `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm typecheck`; `pnpm exec vitest run`; `grep` guard/sanitizeFilename/decodeUploadContent in `connection.ts`; `package.json` dependabot pins; `bash -n deploy/build-frontend.sh`; `docker compose config --services` (default vs `--profile app`). All in the `crm-app` worktree on `main` @ `bb16e41`. Read-only except the two cherry-picks; nothing pushed or deployed.
