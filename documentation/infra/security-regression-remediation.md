# Security Regression Remediation — socket-gateway hardening lost in merge `ecd655c`

> **Date:** 2026-06-24 · **Branch:** `fix/restore-socket-security-hardening` (off `001-yiji-crm-platform` @ `ef31b01`) · **Status:** implemented, tests green, **NOT merged**.
> **Verdict:** the quality verification report is **CONFIRMED**. Merge `ecd655c` (Merge PR #29 — "converge frontend stream into 001") overwrote `services/socket-gateway/src/connection.ts` with a frontend-stream copy that had **lost three security hardenings** present in the secure baseline.

---

## 1. Verification

**Claim:** `001` lost security hardening during merge commit `ecd655c`.

**Method:** compared current `001` (`ef31b01`) against the secure baseline commit **`989da1f`** ("security: fix customer IDOR + harden uploads, AI DoS, and the prod edge", 2026-06-22) and **`stream/infra`**. All three are in the same repo; the helper functions still exist but their **call sites were dropped**.

**Evidence (verified by grep + diff):**

| #   | Hardening                                            | `989da1f` / `stream/infra`                                                                                                          | current `001` (`ef31b01`)                                                                                                                     |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`message:send` conversation binding (IDOR guard)** | `connection.ts` rejects a customer whose payload `conversationId` ≠ the handshake-bound `data.conversationId` (`code: 'forbidden'`) | **Guard absent** — payload `conversationId` used directly to persist + broadcast                                                              |
| 2   | **`sanitizeFilename` usage**                         | `connection.ts:321` `const filename = sanitizeFilename(data?.filename)`                                                             | **Not called** — inline `typeof data?.filename === 'string' ? data.filename : 'upload'` (no path-strip, no control/bidi strip, no length cap) |
| 3   | **`decodeUploadContent` usage**                      | `connection.ts:323` `const buf = decodeUploadContent(data?.content)`                                                                | **Not called** — inline decode                                                                                                                |

- `ecd655c` touched `services/socket-gateway/src/connection.ts` (`203` lines changed, mostly deletions) — the regression vector.
- Confirmed both helpers (`sanitizeFilename`, `decodeUploadContent`) are still **defined and unit-tested** in `attachments.ts`, but had **zero call sites in `src/`** on `001` — dead code since the merge.
- The merge also **dropped the IDOR regression test** (`989da1f` had `message:send from a customer is REJECTED when targeting another conversation (IDOR)`; current `001` had no equivalent).

**Impact:**

- **#1 (high):** cross-tenant message injection. A customer socket bound to conversation A could persist/broadcast a message into any conversation B by supplying its id — a classic IDOR.
- **#2 (medium):** filename injection. Unsanitized client filenames allow path traversal (`../../etc/passwd` → stored/offered as a download name), and Unicode bidi-override (RLO) extension spoofing (e.g. `photo‮gpj.exe` rendering as `photo<exe>.jpg`).
- **#3 (medium + correctness):** the inline decode used `Buffer.from((view).buffer)` — reading the **whole pooled `ArrayBuffer`** and ignoring `byteOffset`/`byteLength`. Beyond losing the hardened path, this **silently corrupts uploads** that arrive as a Socket.IO buffer slice (documented in `decodeUploadContent`'s own comment).

---

## 2. Restoration (what was changed)

All edits in `services/socket-gateway/src/connection.ts`, restored faithfully from `989da1f`:

1. **Import** the helpers:

   ```ts
   import {
     validateAttachments,
     sanitizeFilename,
     decodeUploadContent,
     type AttachmentPolicy,
   } from './attachments.js';
   ```

2. **`message:send` IDOR guard** — inserted after payload parse, before persist:

   ```ts
   if (data.kind === 'customer' && conversationId !== data.conversationId) {
     return socket.emit(SOCKET_EVENTS.error, {
       code: 'forbidden',
       message: 'conversation not accessible',
     });
   }
   ```

   (Customers are bound to one conversation at handshake; agents operate the shared inbox, so the guard constrains customers only.)

3. **`attachment:upload`** — replaced the inline filename/decode with the hardened helpers:

   ```ts
   const filename = sanitizeFilename(data?.filename);
   const mimetype = typeof data?.mimetype === 'string' ? data.mimetype.toLowerCase() : '';
   const buf = decodeUploadContent(data?.content);
   if (!buf) return respond({ ok: false, error: 'no file content' });
   ```

4. **Regression test restored** in `services/socket-gateway/tests/connection.test.ts` — the lost IDOR test plus an "own conversation still persists" companion (from `989da1f`).

> Scope was kept to the three named hardenings + their dropped test. No unrelated changes from `989da1f` (AI DoS / prod edge) were pulled in.

---

## 3. Verification of the fix

Run from the `crm-app-infra` worktree on `fix/restore-socket-security-hardening`:

- **Typecheck:** `pnpm exec tsc --noEmit` (socket-gateway) → **exit 0**.
- **Unit tests:** `pnpm exec vitest run services/socket-gateway` → **119 passed** (was 117; +2 restored IDOR tests). `connection.test.ts` now **24 tests** (was 22).
- New tests confirm: customer→other-conversation is rejected with `forbidden` and **not** persisted; customer→own-conversation still persists.

---

## 4. Status / next steps

- **NOT merged**, per instruction. Changes live on `fix/restore-socket-security-hardening` (local; not pushed).
- Recommended follow-up (out of scope here):
  1. Open a PR into `001-yiji-crm-platform` and merge after review.
  2. **Audit `ecd655c` for other dropped hardenings** — that merge rewrote `connection.ts`, `directus.ts`, `customer-jwt.ts`, `config.ts`, and `queue.ts` from the frontend stream; this remediation only covers the three reported items. A broader `989da1f`-vs-`001` diff of the gateway is warranted.
  3. Add a CI guard/lint to flag exported security helpers that have no `src/` call sites (would have caught this dead-code regression).
  4. Reconcile the running deployment (currently serving from `main`, not `001` — see `current-runtime-state.md`) once the fix lands.

---

### Files changed on this branch

- `services/socket-gateway/src/connection.ts` — restored import + IDOR guard + helper usage.
- `services/socket-gateway/tests/connection.test.ts` — restored IDOR + own-conversation tests.
- `documentation/security-regression-remediation.md` — this report.
