# Convergence — Final Remediation (A, B, C)

> **Date:** 2026-06-24 · **Goal:** one deployable `main` that passes Quality verification.
> **Branch:** `main` (in the `crm-app` worktree). **Local only — not pushed, not deployed.**
> **Implemented:** A, B, C. **D:** recommendations only (NOT implemented, per instruction).

---

## Commit hashes

| SHA       | Task      | Commit                                                                                  |
| --------- | --------- | --------------------------------------------------------------------------------------- |
| `757f5e0` | **A + C** | fix(gateway): restore `decodeUploadContent` + CI guard for security-helper call sites   |
| `bb16e41` | **B**     | fix(infra): gate app services behind a Compose `app` profile (cherry-pick of `93c1358`) |
| `92bd034` | **B**     | deploy: Linux single-repo frontend build (cherry-pick of `fd8c21c`)                     |

`main` history: `d1f210d → 92bd034 → bb16e41 → 757f5e0`.

> **B was already on `main`** from the earlier cherry-picks (`92bd034`, `bb16e41`) — verified present (`deploy/build-frontend.sh` exists; `docker-compose.yml` has `profiles: ['app']` on all 3 app services). No re-work needed.

---

## Task A — restore `decodeUploadContent` usage

`services/socket-gateway/src/connection.ts`, `attachment:upload` handler:

```diff
-    let buf: Buffer | null = null;
-    if (data?.content instanceof ArrayBuffer) buf = Buffer.from(data.content);
-    else if (ArrayBuffer.isView(data?.content as ArrayBufferView))
-      buf = Buffer.from((data.content as ArrayBufferView).buffer);   // ignored byteOffset/byteLength
-    else if (typeof data?.content === 'string') buf = Buffer.from(data.content, 'base64');
-    if (!buf || buf.length === 0) return respond({ ok: false, error: 'no file content' });
+    const buf = decodeUploadContent(data?.content);
+    if (!buf) return respond({ ok: false, error: 'no file content' });
```

…and added `decodeUploadContent` to the `./attachments.js` import. The inline decoder read the whole pooled `ArrayBuffer` (ignoring `byteOffset`/`byteLength`), which could corrupt uploads delivered as a Socket.IO buffer slice; `decodeUploadContent` copies only the view window. This closes the last open item from the convergence audit (finding #6) on `main`.

## Task B — deploy/build-frontend.sh + Compose app profile

Already present on `main` (cherry-picks `92bd034` + `bb16e41`). Verified:

- `deploy/build-frontend.sh` — present, executable, `bash -n` clean; builds agent/admin/widget and strips the widget demo host page.
- `docker-compose.yml` — `profiles: ['app']` on `socket-gateway`, `workers`, `ai-gateway`. `docker compose config --services` → infra only (`directus, postgres, redis`); `--profile app` → adds the 3 app services.

## Task C — CI protection (defined-but-uncalled security helper ⇒ CI fails)

- **New script** `.github/scripts/check-security-callsites.mjs` — scans all non-test `.ts` source; for each guarded helper (`sanitizeFilename`, `decodeUploadContent`) it fails if the helper is **exported but has zero runtime call sites** (calls in tests do not count). Extensible via a `GUARDED` array.
- **New package script** `guard:security-callsites` (`package.json`).
- **New CI step** in `ci.yml` → `quality` job, after Typecheck: `pnpm guard:security-callsites`.

This makes the exact `ecd655c` failure mode (helper present + unit-tested, but the handler stopped calling it — invisible to typecheck/lint/tests) a hard CI error.

---

## Files changed (commit `757f5e0`)

| File                                           | Change                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `services/socket-gateway/src/connection.ts`    | A — import + `decodeUploadContent(data?.content)` in `attachment:upload` |
| `.github/scripts/check-security-callsites.mjs` | C — new guard script (90 lines)                                          |
| `.github/workflows/ci.yml`                     | C — new "Security helper call-site guard" step in `quality`              |
| `package.json`                                 | C — `guard:security-callsites` script                                    |

---

## Validation results (run on `main` @ `757f5e0`)

| Check                                                         | Result                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Call-site guard (positive)**                                | ✅ `sanitizeFilename: 1`, `decodeUploadContent: 1` → passed                                                                             |
| **Call-site guard (negative / non-vacuous proof)**            | ✅ with the decode reverted to inline, guard **exits 1** (`decodeUploadContent: EXPORTED but has NO runtime call site`) — then restored |
| **Lint** (`pnpm lint`)                                        | ✅ PASS                                                                                                                                 |
| **Typecheck** (`pnpm typecheck`, 11 pkgs incl. `packages/ui`) | ✅ PASS                                                                                                                                 |
| **Tests** (`pnpm exec vitest run`, services + packages)       | ✅ **35 files / 289 passed**                                                                                                            |
| **`decodeUploadContent` call site present**                   | ✅ verified post-commit (after prettier hook)                                                                                           |
| **B artifacts present**                                       | ✅ build-frontend.sh + Compose `app` profile (config-verified)                                                                          |

---

## Final branch status

- **`main` @ `757f5e0`** is the single deployable branch: deploy/build tooling (Linux build + Compose profile) + full socket-gateway security (4 IDOR guards, `sanitizeFilename`, `decodeUploadContent`) + dependabot patches + all gateway features + the new CI guard.
- **Local only.** `origin/main` still `d1f210d`; nothing pushed, nothing deployed (the changed files do not affect the running `tsx` services).
- The original 3 blockers are cleared: ① `decodeUploadContent` restored (A), ② build-frontend.sh present (B), ③ Compose `app` profile present (B) — plus the CI guard (C) prevents recurrence of ①.

---

## Task D — explicit recommendations (NOT implemented)

### D.1 `WIDGET_CORS_ORIGIN` (convergence-audit #5, MEDIUM)

**Finding:** `WIDGET_CORS_ORIGIN` defaults to `'*'` and is **exempt** from the production no-wildcard `superRefine` that guards `CORS_ORIGIN`; it governs the Socket.IO server origin (`index.ts`).

**Recommendation — _Keep `*` allowed for the widget socket, but make it an explicit, fail-closed decision (not a silent default):_**

1. The widget embeds on **arbitrary vendor storefronts**, so an exhaustive origin allow-list is generally infeasible; origin is **intentionally not the auth boundary** — the signed **HS256 customer JWT** is. So `*` is defensible _by design_.
2. The real defect is that it is a **silent default**. Change it to **require `WIDGET_CORS_ORIGIN` to be set explicitly in production** (fail closed if unset) — even when the chosen value is `*` — so wildcard is a conscious, audited choice, not an accident.
3. For single-tenant / known-embed deployments, support an **optional explicit allow-list** value.
4. Document the rationale in `deploy/README.md` and a `config.ts` comment.

- **Decision owner:** security/product. **Effort:** small (one `superRefine` clause + docs). **Not a code change in this task.**

### D.2 customer-jwt phone-only behavior (convergence-audit #7, LOW)

**Finding:** the contact-identifier requirement was narrowed from **phone-OR-email** to **phone-only**; blank `email`/`name` normalize to `undefined`. JWT **signature verification is unchanged** (HS256 pinned; `alg:none` prevented) — authentication strength is intact.

**Recommendation — _Confirm-and-document; most likely ACCEPT (no code change):_**

1. The code comments state this is deliberate ("Phone is the ONLY mandatory contact identifier — the host guarantees it"). It does **not** weaken token auth — it narrows an identity-completeness guarantee.
2. **Confirm with product** that phone is the intended sole mandatory identifier. If yes (expected): **ACCEPT** and document the contact-identity contract (host MUST mint a valid phone; email optional) in the widget/token integration docs — no code change.
3. If phone-as-sole-identifier is **not** intended, restore the `phone || email` requirement in `customer-jwt.ts`.

- **Decision owner:** product. **Effort:** docs only if accepted. **Not a code change in this task.**

---

### Verification trail

Edits to `connection.ts` (A); new guard script + `ci.yml` step + `package.json` script (C); B verified present from prior cherry-picks. `pnpm guard:security-callsites` (positive pass + negative exit-1 mutation), `pnpm lint`, `pnpm typecheck`, `pnpm exec vitest run` (289 passed). Committed `757f5e0` (pre-commit eslint+prettier hooks ran clean). All in the `crm-app` worktree on `main`. Nothing pushed or deployed.
