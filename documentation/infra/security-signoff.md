# Security Sign-Off — Post-Convergence `main`

**Date:** 2026-06-24
**Branch:** `main` @ **`60f2581`** — **pushed** (`origin/main` == local `main`).
**Converged via:** PR **#35** ("convergence/security-deploy-into-main", merge `c0a67f3`) + `60f2581` (ported typing/read IDOR tests).
**Baseline:** secure `989da1f`; audit `security-convergence-audit.md`.
**Method:** read-only `git show`/`grep` of committed code **+ live execution** (CI security guard, `docker compose config`, socket-gateway test suite). No code modified.

---

# ✅ VERDICT: **SIGNED_OFF**

All three confirmation criteria are met. The security regressions introduced during stream convergence are fully remediated on a pushed, test-green, deployable branch, and the only open items are explicit architectural decisions — no outstanding security defects.

---

## 1. Security convergence complete — ✅ CONFIRMED

All seven items verified on `main` `60f2581` (code + live):

| Item                           | Evidence                                        | Result |
| ------------------------------ | ----------------------------------------------- | ------ |
| `message:send` IDOR guard      | `connection.ts:292` (handler `:273`)            | ✅     |
| `typing:start/stop` IDOR guard | `connection.ts:472` (loop `:467`)               | ✅     |
| `read:ack` IDOR guard          | `connection.ts:486` (handler `:481`)            | ✅     |
| `sanitizeFilename` usage       | `connection.ts:350` + CI guard                  | ✅     |
| `decodeUploadContent` usage    | `connection.ts:352` + CI guard                  | ✅     |
| Linux build script             | `deploy/build-frontend.sh` (strips widget demo) | ✅     |
| Compose `app` profile          | `docker-compose.yml` 3× `profiles:['app']`      | ✅     |

Closes audit findings **#1 (CRITICAL), #2, #3, #4, #6**. Live gate results on `60f2581`:

```
node .github/scripts/check-security-callsites.mjs  → ✓ sanitizeFilename + ✓ decodeUploadContent wired; guard passed
docker compose config --services                   → directus postgres redis   (app profile ⇒ infra-only)
pnpm exec vitest run services/socket-gateway       → 14 files / 121 tests passed (connection.test.ts = 26)
```

Regression-prevention is now structural: the new **CI call-site guard** fails the build if `sanitizeFilename`/`decodeUploadContent` lose their call sites (the exact way #5/#6 regressed twice), and the **typing/read IDOR regression tests were ported to `main`** (`60f2581`) — so items 2/3 can no longer silently regress.

## 2. Runtime-safe branch exists — ✅ CONFIRMED

`main` @ `60f2581` is that branch: pushed to origin, carries every IDOR/upload guard **and** the upload-integrity fix that was reverted on the prior `origin/main` (`d1f210d`), passes the full socket-gateway suite, and ships infra-only-by-default compose + the safe Linux build. It is deployable and runtime-safe.

**Required usage condition (governance, not a security defect):** the deploy source must be **`main`**, not `001`. `origin/001-yiji-crm-platform` still has **zero** IDOR guards (`grep 'conversation not accessible'` → 0) and remains forked from `main` (33 ahead / 16 behind). Deploying `001` would reintroduce the CRITICAL IDOR. Recommend reconciling/retiring `001` and designating `main` the single deploy source. Also rebuild/redeploy the running services from `60f2581` (the previously-running build predates it).

## 3. Remaining issues are decisions, not defects — ✅ CONFIRMED

| Item                                                                                                                      | Nature                                                                                                                                          | Status                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `WIDGET_CORS_ORIGIN='*'` exempt from the prod no-wildcard guard (`config.ts:27`; `superRefine` guards only `CORS_ORIGIN`) | **Architectural decision** — the widget embeds on arbitrary vendor storefronts; the signed HS256 customer JWT is the auth boundary, not origin. | Ratify the documented `*` exception **or** add a prod allow-list. Mitigated today by JWT auth. |
| `customer-jwt` requires phone-only (`customer-jwt.ts:58`; `email` optional; HS256 pinned `:45`)                           | **Architectural / product decision** — phone is the host-guaranteed identifier. Auth strength intact (alg:none prevented).                      | Confirm intended + document.                                                                   |

No outstanding security **defects** remain; both items are deliberate design choices awaiting formal ratification + documentation.

---

## Conditions attached to this sign-off (non-blocking for security; operational)

1. Deploy from **`main`** only; reconcile or retire `001` (it is insecure).
2. Rebuild/redeploy running services from `60f2581`.
3. Ratify + document the two architectural decisions (`WIDGET_CORS_ORIGIN`, `customer-jwt`).

These are governance/ops follow-ups; they do not affect the security correctness of the converged code, which is **signed off**.

---

_Read-only sign-off. No source modified. Verified on `main` `60f2581` (= `origin/main`); baseline `989da1f`. Live commands run in the `crm-app` worktree. 2026-06-24._
