# Final Convergence Verification

**Date:** 2026-06-24
**Convergence branch verified:** `main` @ **`757f5e0`** (checked out in the `crm-app` worktree; **local only — not yet pushed**; `origin/main` is still `d1f210d`).
**Method:** read-only `git show`/`grep` of committed code **+ live execution** (CI security guard, `docker compose config`, `bash -n`, full socket-gateway test suite). No code modified.

The convergence branch added exactly the three items that previously failed (`main-final-verification.md`):
`92bd034` Linux build script · `bb16e41` Compose `app` profile · `757f5e0` restore `decodeUploadContent` + a CI call-site guard.

---

# ✅ VERDICT: **PASS WITH DECISIONS_PENDING**

All **7 verification items PASS** (code-verified and live-tested). The only outstanding items are the **two architectural decisions** (`WIDGET_CORS_ORIGIN`, `customer-jwt`), which — per scope — are treated as decisions to ratify/document, **not defects**. One non-blocking quality note (test coverage) is recorded.

| #   | Item                          | Result  | Evidence                                                                                                                     |
| --- | ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | `message:send` guard          | ✅ PASS | `connection.ts:289` (handler `:273`); regression test `connection.test.ts:330`                                               |
| 2   | `typing` guard                | ✅ PASS | `connection.ts:472` (loop `:467`)                                                                                            |
| 3   | `read`/`readAck` guard        | ✅ PASS | `connection.ts:486` (handler `:481`)                                                                                         |
| 4   | `sanitizeFilename` usage      | ✅ PASS | `connection.ts:350` (import `:22`); CI guard ✓; `attachments.test.ts`                                                        |
| 5   | `decodeUploadContent` usage   | ✅ PASS | `connection.ts:352` + null-check (import `:23`); CI guard ✓; `attachments.test.ts`                                           |
| 6   | Linux build script present    | ✅ PASS | `deploy/build-frontend.sh` (builds 3 apps `:34-36`; strips widget demo `:41`); `bash -n` ✓                                   |
| 7   | Compose `app` profile present | ✅ PASS | `docker-compose.yml` `profiles: ['app']` on `:106/:127/:149`; `docker compose config --services` → `directus postgres redis` |

| Architectural decision    | State                                                                             | Disposition                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WIDGET_CORS_ORIGIN`      | `config.ts:27` `default('*')`; `superRefine` (`:44-49`) guards only `CORS_ORIGIN` | **DECISION PENDING** — ratify `*` as a documented exception (signed customer JWT is the boundary; widget embeds on arbitrary storefronts) **or** add a prod allow-list. Not a defect. |
| `customer-jwt` identifier | `customer-jwt.ts:58` phone-only; `email` optional (`:27`); HS256 pinned (`:45`)   | **DECISION PENDING** — confirm phone-only is the intended product contract and document it. Auth strength intact (alg:none prevented). Not a defect.                                  |

---

## Live verification results (executed on `main` `757f5e0`)

```
$ node .github/scripts/check-security-callsites.mjs
  ✓ sanitizeFilename: 1 runtime call site(s).
  ✓ decodeUploadContent: 1 runtime call site(s).
  Security call-site guard passed.

$ docker compose config --services        → directus postgres redis        (app profile ⇒ infra-only by default)
$ bash -n deploy/build-frontend.sh        → ok (parses)

$ pnpm exec vitest run services/socket-gateway
  Test Files  14 passed (14)
       Tests  119 passed (119)        (connection.test.ts = 24)
```

- **#4/#5 are provably wired, not dead code:** the new CI guard `.github/scripts/check-security-callsites.mjs` (`GUARDED = ['sanitizeFilename','decodeUploadContent']`, wired into `ci.yml` + `package.json`) fails the build if either helper loses its `src/` call site. This is the exact regression that `ecd655c` (on `001`) and a `stream/*` merge (on `main`) each introduced — now caught automatically.
- **#7 app profile works:** a bare `docker compose up -d` starts infra only; the Node tier stays under PM2 (no `:8080` clash, no duplicate BullMQ consumer).
- **No regression:** all guards present, suite green; the `decodeUploadContent` upload-integrity fix that was reverted on `origin/main` is restored.

## Detail per finding (vs the convergence-audit baseline `989da1f`)

- **#1 message:send (was CRITICAL):** `if (data.kind === 'customer' && conversationId !== data.conversationId)` → `code:'forbidden'`. Customer cross-conversation write rejected; agents (shared inbox) unconstrained by design. Covered by `connection.test.ts:330`.
- **#2 typing / #3 read:ack (were MEDIUM):** identical predicate `parsed.data.conversationId !== data.conversationId` with a silent `return` (matches baseline — ephemeral signals dropped quietly).
- **#4 sanitizeFilename / #5 decodeUploadContent (were MEDIUM/LOW):** both imported and called in `attachment:upload`; `decodeUploadContent` copies only the view window (fixes the `byteOffset/byteLength` corruption); `!buf` rejection preserved; MIME allow-list + size cap intact.

---

## Notes (non-blocking)

1. **Test coverage gap for items 2 & 3.** `main` proves `message:send` IDOR with a test (`:330`), but has **no dedicated typing/read IDOR regression tests** — the guards are present in code and the suite is green, but the Phase-2 branch's two extra tests (`typing:start … dropped (IDOR)`, `read:ack … dropped (IDOR)`; suite was 121 there vs 119 here) are not on `main`. **Recommend** porting those two tests and extending the call-site-style CI guard to the IDOR guards, so items 2/3 can't silently regress the way #5/#6 did.
2. **Branch state.** The convergence branch is **local `main` `757f5e0`, not pushed** (`origin/main` = `d1f210d`). `main` and `001` remain **forked** (31 ahead / 16 behind) and **`001` still lacks all the IDOR guards** — deploying `001` would be insecure. **Recommend** pushing `757f5e0`, reconciling `001` onto it (or retiring `001`), and designating one branch the single deploy source.

---

_Read-only verification. No source modified. Verified on `main` `757f5e0`; baseline `989da1f`. Live commands run in the `crm-app` worktree. 2026-06-24._
