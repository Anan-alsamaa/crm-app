# Branch Convergence — Final Report

> **Date:** 2026-06-24 · **Type:** analysis only. **Nothing merged, nothing modified.**
> **Branches compared:**
>
> 1. `origin/main` (`d1f210d`)
> 2. `origin/001-yiji-crm-platform` (`ef31b01`) — GitHub default / PR integration target
> 3. **the fix branch `73717ea`** — _note:_ `73717ea` is the HEAD of **`fix/socket-idor-typing-read-phase2`** (Phase 2), which is stacked on `fix/restore-socket-security-hardening` (`dafbba7`, Phase 1). Together = "the cumulative security fix branch." It is a **strict superset of `001`** (`001` is an ancestor of `73717ea`).

---

## 0. The decisive measurement

`main` vs `001` differ in `connection.ts` by **only 21 lines (2 ins / 19 del)** — and those lines are **exactly the customer IDOR guards**:

|                 | `connection.ts` lines | IDOR guards                                 | gateway features (attachment:get, getConversationAttachment, loadConversationMessages, getConversationStatus, conversationSubscribe) |
| --------------- | --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `main`          | **555**               | ✅ all 4 (message:send, typing, read, csat) | ✅ all present                                                                                                                       |
| `001 @ ef31b01` | 538                   | ❌ only csat (regressed by `ecd655c`)       | ✅ all present                                                                                                                       |
| fix `73717ea`   | **555**               | ✅ all 4 (restored)                         | ✅ all present                                                                                                                       |

So `main` already contains **every** frontend-convergence feature _and_ the security guards. The fix branch effectively **re-derived `main`'s secure `connection.ts` onto `001`** (fix `connection.ts` == `main` `connection.ts`, both 555 lines). `directus.ts` is **byte-identical** across `main` and `001`.

---

## 1. Which branch is the most complete and secure?

**`main`.** Measured by missing content from the union of all three:

| Branch          | Missing from the union                                                                            | Security gaps?                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **`main`**      | only **2** items: `deploy/build-frontend.sh` (Linux build) + Compose `app` profile                | **none** — has IDOR guards **and** dependabot patches **and** all gateway features   |
| `001 @ ef31b01` | 5 items: IDOR guards, dependabot patches, ops lane, agent attachment fix, `DIRECTUS_INTERNAL_URL` | **2 security gaps** (IDOR + vulnerable deps)                                         |
| fix `73717ea`   | 4 items: dependabot patches, ops lane, agent attachment fix, `DIRECTUS_INTERNAL_URL`              | **1 security gap** (vulnerable deps — vitest ^2.1.8, no form-data/esbuild overrides) |

- `main` is the **only fully secure** branch (application code **and** dependencies) and is missing just **two non-security deploy conveniences**.
- The fix branch is the most complete on the **deploy axis** (it carries `001`'s Linux build + Compose profile) and has app-code security parity with `main`, **but still ships the vulnerable dependency set** that `main` already patched.
- `001` (the nominal default) is the **least** complete/secure of the three as it stands.

> Caveat: `001` is the GitHub **default branch** and the team's PR target. "Most complete/secure by content" (`main`) is therefore not the same as "the branch the process expects to be authoritative" (`001`). §4 resolves this.

---

## 2. Exact commits that must move INTO `001`

To make `001` the authoritative superset, it needs (all verified absent from `001` by content):

**Security — via the prepared fix branch (one merge):**

- `dafbba7` — message:send IDOR guard + sanitizeFilename + decodeUploadContent (Phase 1)
- `73717ea` — typing + read IDOR guards (Phase 2)

**From `main` (cherry-pick):**

- `9a9a6c2` — fix(deps): dependabot patches (vitest 3.x, form-data/esbuild overrides) — **security**
- `e41e9f6` — fix(agent): fetch attachments via SDK so H-2 cookie-auth refresh applies _(directus.ts differs between main and 001 — confirmed needed)_
- `c921e2d` — docs(env): `DIRECTUS_INTERNAL_URL` in `.env.example`
- `b3b4dc5`, `97e04fc`, `a47f660`, `d1f210d` — the ops / incident-response lane (CLAUDE.md + permissions), if it is to live on the canonical branch

> Do **not** also pull `main`'s `connection.ts` — the fix branch already brings `001`'s `connection.ts` to parity with `main`. Pulling both would conflict.

## 3. Exact commits that must move INTO `main`

To make `main` the authoritative superset, it needs **only 2 commits** (the sole content `main` lacks):

- `fd8c21c` — deploy: Linux single-repo frontend build (`deploy/build-frontend.sh`) (PR #31)
- `93c1358` — fix(infra): gate app services behind a Compose `app` profile (PR #33)

> `main` does **not** need the fix-branch commits — it already has all 4 IDOR guards. It already has the dependabot patches, all gateway features, bootstrap idempotence, no-cache SPA headers, and the e2e selector fix (verified content-present).

---

## 4. Shortest path to one authoritative branch

**Shortest (pure mechanics): converge into `main` — 2 cherry-picks.**
`main` is already a near-complete, fully-secure superset; it lacks only `fd8c21c` + `93c1358`. Cherry-pick those two and `main` becomes the single authoritative branch. (Expect at most minor doc conflicts in `deploy/README.md`/`docker-compose.yml`; the new `build-frontend.sh` and the `profiles:` additions are essentially additive.)

**Alternative (honors the `001` default): converge into `001` — ~6 operations.**
Merge the fix branch (1 clean merge, gates already green per `security-merge-readiness.md`) + cherry-pick 5 `main` commits (the dependabot patch carries an expected `pnpm-lock.yaml` conflict — regenerate via `pnpm install`).

**Why the `main` direction is shorter:** the expensive, security-critical delta (the IDOR guards) is _already_ on `main`. The `001` direction has to _import_ that delta (via the fix branch) **and** the dependency patches **and** the ops lane — whereas `main` only needs two additive deploy files.

---

## 5. Recommended merge sequence

Two valid end-states. Pick based on whether the org requires `001` to remain the default branch.

### Option A — Authoritative = `main` (fastest; recommended if branch identity is flexible)

1. `git switch main`
2. `git cherry-pick fd8c21c` (Linux build) — resolve any `deploy/README.md` conflict by keeping both.
3. `git cherry-pick 93c1358` (Compose `app` profile) — resolve any doc conflict by keeping both.
4. Run gates: `pnpm lint && pnpm typecheck && pnpm exec vitest run`.
5. `main` is now the single authoritative superset. Update the GitHub default branch to `main` (or treat `main` as the deploy source going forward).
6. **Optional realignment of `001`:** merge the fix branch into `001`, then `git merge main` into `001` (both `connection.ts` now 555 lines → clean) so the two names converge. _(Needed only if `001` must keep living.)_
   - The prepared fix-branch PR into `001` becomes **unnecessary for security** under this option (main already has the guards) — keep it only if `001` is being realigned.

### Option B — Authoritative = `001` (honors the GitHub default / PR model)

1. Open the prepared PR `fix/socket-idor-typing-read-phase2` → `001` and merge it (restores the IDOR guards; rebase is a no-op, lint green, 291 tests green per `security-merge-readiness.md`).
2. Cherry-pick into `001`, in order: `9a9a6c2` (dependabot — regenerate `pnpm-lock.yaml`), `e41e9f6` (agent fix), `c921e2d` (env), then the ops lane `b3b4dc5 97e04fc a47f660 d1f210d`.
3. Run gates on `001`.
4. `001` is now the authoritative superset. Fast-forward / merge `001 → main` so `main` matches (clean — `connection.ts` is now 555 on both).
5. Going forward, all PRs target `001` (status quo).

**Recommendation:** if there is no hard requirement to keep `001` as the default, take **Option A** — it reaches one authoritative, fully-secure branch in **2 commits** and matches what is already deployed (runtime runs from `main`). If the GitHub-default/PR-integration model must be preserved, take **Option B** (the prepared fix branch makes step 1 turnkey). Either way you end with a single superset; only the branch _name_ differs.

---

## 6. Risks & notes

- **Concurrent session** has been moving these branches this session — re-verify `origin/main`, `origin/001`, and `73717ea` HEADs immediately before any cherry-pick/merge.
- **Dependabot cherry-pick** (Option B step 2) will conflict on `pnpm-lock.yaml`; resolve by `pnpm install`, not by hand.
- **Never blind-`git merge main → 001`** to fix security: the 3-way base (`066721a`) already had the guards, `001` deleted them, `main` left them unchanged → git keeps `001`'s deletion and the guards stay gone. Use the fix branch (Option B step 1) or take `main`'s file via `-X theirs` explicitly.
- This report supersedes the directional lean in `runtime-reconciliation-plan.md` §3 now that content overlap is precisely measured: by **content**, `main` — not `001` — is the most complete and secure branch today.
- **Do not merge / modify** — this is the plan only.

---

### Verification trail

`git merge-base --is-ancestor 001 73717ea` (superset); `git diff --stat main 001 -- connection.ts directus.ts` (21-line delta, directus identical); per-feature `grep` counts across `main`/`001` connection.ts+directus.ts (all gateway features present in both); `connection.ts` line counts (main 555 / 001 538 / fix 555); `package.json` pins (vitest/form-data/esbuild — main patched, 001 not); CLAUDE.md ops-lane grep (main 3 / 001 0); `git cat-file -e` for `build-frontend.sh` (main lacks) and compose `profiles:` (main 0); content-presence of no-cache / bootstrap-idempotence / e2e-selector fix (all already in `main`). Read-only.
