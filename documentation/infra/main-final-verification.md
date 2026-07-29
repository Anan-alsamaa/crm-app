# Converged `main` — Final Verification

**Date:** 2026-06-24
**Branch reviewed:** `origin/main` @ `d1f210d`
**References:** secure baseline `989da1f`; audit `security-convergence-audit.md`; remediation `security-regression-remediation.md`; comparison branch `001-yiji-crm-platform` @ `ef31b01`.
**Method:** read-only `git show origin/main:<file>` + `grep` + history/ancestry checks. No code modified.

---

# ⛔ VERDICT: **FAIL**

`main` has the **security IDOR hardening done well** (the CRITICAL + both MEDIUM IDOR guards are all present — better than `001`), **but** it fails three of the five verification criteria: a convergence **regression was re-introduced** (#6 upload decode), **Linux build support is missing**, and the **Compose `app` profile is missing**. Credit where due on security; the branch is still not a clean converged state.

| Verification item                              | Result                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| 1. Security findings (audit #1–#7)             | ⚠️ 4 fixed, #6 **reverted**, #5/#7 open            |
| 2. Regression-remediation fixes (#1,#4,#6)     | ⚠️ #1 ✅, #4 ✅, **#6 ❌**                         |
| 3. Linux build support                         | ❌ **Missing** (`deploy/build-frontend.sh` absent) |
| 4. Compose `app` profile                       | ❌ **Missing** (0 profiles; `93c1358` not in main) |
| 5. No regression introduced during convergence | ❌ **FAIL** (#6 decode fix reverted)               |

---

## 1. Security findings from `security-convergence-audit.md` (verified on `main`)

| #   | Finding                                                     | Severity | Status on `main`   | Evidence (`connection.ts` / file)                                                                                                                                                                                   |
| --- | ----------------------------------------------------------- | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `message:send` conversation IDOR                            | CRITICAL | ✅ **Fixed**       | `:284` `if (data.kind === 'customer' && conversationId !== data.conversationId)` → `code:'forbidden'` (handler `:268`)                                                                                              |
| 2   | `typing:start/stop` IDOR                                    | MEDIUM   | ✅ **Fixed**       | `:471` `if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;` (loop `:466`)                                                                                                  |
| 3   | `read`/`readAck` IDOR                                       | MEDIUM   | ✅ **Fixed**       | `:485` same guard (handler `:480`)                                                                                                                                                                                  |
| 4   | `attachment:upload` `sanitizeFilename`                      | MEDIUM   | ✅ **Fixed**       | `:345` `const filename = sanitizeFilename(data?.filename);`                                                                                                                                                         |
| 5   | `WIDGET_CORS_ORIGIN='*'` exempt from prod no-wildcard guard | MEDIUM   | ❌ **OPEN**        | `config.ts:27` `WIDGET_CORS_ORIGIN: z.string().default('*')`; `superRefine` (`:44-49`) checks **only** `CORS_ORIGIN`. Unchanged from baseline; mitigated by the signed customer JWT. Needs the documented decision. |
| 6   | `attachment:upload` `decodeUploadContent`                   | LOW      | ❌ **Reverted**    | upload handler uses inline `Buffer.from((data.content as ArrayBufferView).buffer)` (ignores `byteOffset`/`byteLength`); `decodeUploadContent` **not imported/called**. See §5.                                      |
| 7   | customer-jwt phone-only (was phone-OR-email)                | LOW      | ⚠️ **Intentional** | `customer-jwt.ts:58` `if (!parsed.data.phone?.trim()) throw …`; `email` optional (`:27`). HS256 verification intact. Per the audit, a deliberate product change — confirm + document, not a security weakening.     |

**Net:** the auth-impacting regressions (the CRITICAL #1 and both MEDIUM IDOR #2/#3) and the #4 sanitizer are all correctly restored on `main`. #5 and #7 are the same open decisions the audit flagged (not `main`-specific). **#6 is the problem** — it is reverted on `main` (and is a convergence regression, §5).

## 2. Fixes from `security-regression-remediation.md` (Phase 1 = #1, #4, #6)

| Fix                            | On `main`?                                      |
| ------------------------------ | ----------------------------------------------- |
| #1 `message:send` IDOR guard   | ✅ present (`connection.ts:284`)                |
| #4 `sanitizeFilename` usage    | ✅ present (`connection.ts:345`)                |
| #6 `decodeUploadContent` usage | ❌ **absent** — reverted to buggy inline decode |

2 of the 3 Phase-1 fixes are on `main`; **#6 is not**.

## 3. Linux build support — ❌ MISSING

| Path                                                                                      | On `main`?                       |
| ----------------------------------------------------------------------------------------- | -------------------------------- |
| `deploy/build-frontend.sh` (single-repo Linux build, **strips widget demo page**)         | ❌ **MISSING**                   |
| `build-frontend.ps1` (Windows; **bakes `YIJI_JWT_SECRET`** into the widget host page)     | ✅ present — **unsafe for prod** |
| `apps/{agent,admin}-portal/Dockerfile` + `docker-compose.prod.yml` (all-Docker SPA build) | ✅ present                       |

A Linux build is technically achievable via the all-Docker Dockerfile path, **but the canonical hybrid Linux build script is absent**, and with it the widget-demo-strip safety. An operator following the hybrid runbook on Linux has no `build-frontend.sh`; the only standalone script (`.ps1`) is Windows-only and leaks the JWT secret. The PR that added `deploy/build-frontend.sh` (PR #31) is one of the **16 commits on `001` that are not in `main`**.

## 4. Compose `app` profile — ❌ MISSING

`git show origin/main:docker-compose.yml | grep -c profiles` → **0**. The `socket-gateway`/`workers`/`ai-gateway` services have a bare `build:` with **no `profiles:`**, and the app-profile commit `93c1358` is **not an ancestor of `main`**. Consequence: a plain `docker compose up -d` on `main` builds **and starts** the node services, which collide with the PM2 stack on `:8080` and double-consume the BullMQ queue — the exact problem the `app` profile was introduced to solve (on `001`).

## 5. No regression introduced during convergence — ❌ FAIL

**A regression was re-introduced: #6 (upload decode integrity).**

- `main`'s history contains the fix: `45835f2` ("copy only the view window when decoding binary uploads") imported and called `decodeUploadContent` (`45835f2:connection.ts:20,306`), and `92631c8` ("store uploaded attachments uncorrupted (Buffer view bug)").
- Current `main` HEAD's `attachment:upload` handler does **not** call `decodeUploadContent`; it uses `Buffer.from((view).buffer)` (the corrupting whole-pooled-buffer copy).
- Therefore a later convergence merge (the `stream/*` merges into `main`: `508e233`/`c5e863b`/`9a59cca`) overwrote `connection.ts` and dropped the fix — the **same class of regression** as `ecd655c` on `001`. Severity is LOW (data-integrity, not auth), but it is unambiguously a convergence regression and answers this item **No**.

Other controls spot-checked and **intact** on `main` (no regression): the message:send/typing/read IDOR guards (§1), `sanitizeFilename` (§1 #4), and the H-2 cookie-auth commit `f989c72` is in history. (A full re-audit of `directus.ts`/`index.ts`/`ai-gateway` against `989da1f` for `main` specifically was not performed here; the convergence-audit cleared them on `001`, and `main` shares those commits — but the #6 reversion shows convergence merges can silently drop fixes, so a `main`-specific diff of those files against `989da1f` is recommended before trusting them.)

---

## Required to reach PASS

1. **Restore #6:** re-apply `decodeUploadContent` in `attachment:upload` (import + call), matching `45835f2`/`989da1f`. Add a CI guard that fails when an exported security helper (`sanitizeFilename`, `decodeUploadContent`) has no `src/` call site — this regression would have been caught automatically.
2. **Add Linux build support:** bring `deploy/build-frontend.sh` into `main` (it strips the widget demo page); update the runbook to use it; mark `build-frontend.ps1` Windows-demo-only.
3. **Add the Compose `app` profile** to `main`'s `docker-compose.yml` (cherry-pick `93c1358`) so a bare `up` is infra-only and doesn't clash with PM2.
4. **Close the open decisions:** #5 `WIDGET_CORS_ORIGIN` (documented `*` exception vs prod allow-list) and confirm #7 (phone-only) is intentional.
5. Re-run `pnpm exec vitest run services/socket-gateway` + the full suite and re-verify.

Because `main` and `001` have **forked** (28 ahead / 16 behind), the cleanest path is to reconcile them into one branch that carries: main's IDOR guards **+** 001's `decodeUploadContent`, `deploy/build-frontend.sh`, and the `app` profile — then make that the single deploy source.

---

_Read-only verification. No source modified. Verified on `origin/main` `d1f210d`; baseline `989da1f`; comparison `001` `ef31b01`. 2026-06-24._
