# Security Convergence Audit — `989da1f` (secure baseline) vs `001-yiji-crm-platform @ ef31b01`

> **Date:** 2026-06-24 · **Type:** read-only analysis. **Nothing was implemented or merged.**
> **Baseline (secure):** `989da1f` — "security: fix customer IDOR + harden uploads, AI DoS, and the prod edge" (2026-06-22).
> **Target (audit):** `001-yiji-crm-platform @ ef31b01`.
> **Scope:** `services/socket-gateway/`, `services/ai-gateway/` — with explicit attention to `connection.ts`, `directus.ts`, `customer-jwt.ts`, `config.ts`, `queue.ts`.
> **Method:** per-file `git diff 989da1f ef31b01` over committed refs (working tree ignored), parallel analysis, then **independent re-verification** of every CRITICAL/notable finding via `git show <ref>:<file>` and `git grep <pattern> ef31b01` relocation checks. Only **regressions** (present in baseline, absent/weakened in target) are reported; additions are excluded.

---

## Summary

The change `989da1f → ef31b01` is **net additive** (≈1007 insertions / 206 deletions across the two services). The regressions are **concentrated in `socket-gateway/src/connection.ts`** (rewritten by the PR #29 frontend-stream merge `ecd655c`). `directus.ts`, `queue.ts`, `index.ts`, and the **entire `ai-gateway`** carry **no regressions** — and `ai-gateway` was meaningfully **strengthened**.

| #   | Finding                                                                   | File                  | Category              | Severity     | Remediation status                                  |
| --- | ------------------------------------------------------------------------- | --------------------- | --------------------- | ------------ | --------------------------------------------------- |
| 1   | `message:send` conversation IDOR binding removed                          | connection.ts         | authorization (IDOR)  | **CRITICAL** | ✅ fixed on `fix/restore-socket-security-hardening` |
| 2   | `typing:start/stop` IDOR binding removed                                  | connection.ts         | authorization (IDOR)  | **MEDIUM**   | ❌ OPEN                                             |
| 3   | `read`/`readAck` IDOR binding removed                                     | connection.ts         | authorization (IDOR)  | **MEDIUM**   | ❌ OPEN                                             |
| 4   | `attachment:upload` no longer calls `sanitizeFilename`                    | connection.ts         | sanitization          | **MEDIUM**   | ✅ fixed on the same branch                         |
| 5   | `WIDGET_CORS_ORIGIN` defaults to `*`, exempt from prod no-wildcard guard  | config.ts (+index.ts) | CORS / hardening      | **MEDIUM**   | ❌ OPEN                                             |
| 6   | `attachment:upload` `decodeUploadContent` replaced by buggy inline decode | connection.ts         | hardening / integrity | **LOW**      | ✅ fixed on the same branch                         |
| 7   | customer-jwt contact-identifier narrowed (phone-OR-email → phone-only)    | customer-jwt.ts       | validation            | **LOW**      | ❌ OPEN (likely intentional)                        |

**Counts:** CRITICAL 1 · HIGH 0 · MEDIUM 3 · LOW 2. _(No HIGH-severity regressions were found.)_

> Findings **1, 4, 6** are already remediated by the earlier `fix/restore-socket-security-hardening` branch (commit `dafbba7`). Findings **2, 3, 5, 7 remain OPEN** in both `ef31b01` and that branch.

---

## CRITICAL

### 1. `message:send` — customer→conversation IDOR binding removed

- **File:** `services/socket-gateway/src/connection.ts`
- **Category:** authorization (IDOR / cross-tenant injection)
- **What it protects:** a customer socket is bound to exactly one conversation at handshake; the guard prevents a client-supplied `conversationId` from targeting another customer's conversation.
- **Baseline evidence** (`989da1f:connection.ts:254-261`):
  ```ts
  // IDOR guard: a customer socket is bound to exactly ONE conversation ...
  if (data.kind === 'customer' && conversationId !== data.conversationId) {
    return socket.emit(SOCKET_EVENTS.error, {
      code: 'forbidden',
      message: 'conversation not accessible',
    });
  }
  ```
- **Target status:** **ABSENT.** In `ef31b01` the payload `conversationId` flows straight into `directus.persistMessage({ conversationId, ... })` and the room broadcast, with no comparison to `data.conversationId`. Relocation check: `git grep 'conversation not accessible' ef31b01 -- services/socket-gateway` → **no match**; the only surviving `conversationId !== data.conversationId` (`connection.ts:490`) is the **CSAT** handler — a different control.
- **Impact:** a customer who obtains/guesses another conversation's UUID can **persist and broadcast** messages into it — cross-tenant message injection. Highest-impact regression (state-changing + visible to the other tenant).
- **Severity justification:** unauthenticated-to-that-resource write with persistence and broadcast = CRITICAL.

---

## MEDIUM

### 2. `typing:start` / `typing:stop` — IDOR binding removed

- **File:** `connection.ts` · **Category:** authorization (IDOR)
- **Protects:** customers may only emit typing signals into their bound conversation.
- **Baseline** (`989da1f:connection.ts:419-420`):
  ```ts
  // IDOR guard: customers may only signal typing on their bound conversation.
  if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;
  ```
- **Target status:** **ABSENT.** Target typing handler parses then emits to `rooms.conversation(parsed.data.conversationId)` with no binding check. Verified: no equivalent guard survives for this path.
- **Impact:** a customer can spoof typing indicators into arbitrary conversation rooms (ephemeral, no persistence) — requires knowing the target UUID.
- **Severity:** MEDIUM — removed authorization control, low blast radius (ephemeral UX spoof).

### 3. `read` / `readAck` — IDOR binding removed

- **File:** `connection.ts` · **Category:** authorization (IDOR)
- **Protects:** customers may only ack reads on their own bound conversation.
- **Baseline** (`989da1f:connection.ts:432-434`):
  ```ts
  // IDOR guard: a customer may only ack reads on its own bound conversation
  if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;
  ```
- **Target status:** **ABSENT.** Target re-emits `readAck` to `rooms.conversation(parsed.data.conversationId)` with no binding check.
- **Impact:** forged read-receipts into arbitrary conversation rooms (ephemeral). Same UUID-knowledge prerequisite as #2.
- **Severity:** MEDIUM — removed authorization control, low blast radius.

### 4. `attachment:upload` — `sanitizeFilename` no longer invoked

- **File:** `connection.ts` · **Category:** sanitization
- **Protects:** strips path components, ASCII control chars, and Unicode bidi-override (RLO) codepoints from client filenames, and caps length, before the name is stored and later offered to an agent as a download name.
- **Baseline** (`989da1f:connection.ts:321`): `const filename = sanitizeFilename(data?.filename);`
- **Target status:** **WEAKENED.** Target inlines `const filename = typeof data?.filename === 'string' ? data.filename : 'upload';` — raw passthrough. `sanitizeFilename` **still exists and is unit-tested** in `attachments.ts:40` (relocation check) but is **no longer called** by the handler.
- **Impact:** RLO extension-spoofing (e.g. `photo‮gpj.exe` rendering as `photo<…>.jpg`) and path-like names reach `directus.uploadFile(buf, filename, …)`; the agent-facing download name can be weaponized for phishing. MIME allow-list + size cap remain enforced.
- **Severity:** MEDIUM — internal-user social-engineering vector; storage path-traversal unlikely (Directus stores by UUID). **(Already remediated on the fix branch.)**

### 5. `WIDGET_CORS_ORIGIN` defaults to `*` and is exempt from the production no-wildcard guard

- **Files:** `config.ts` (+ `index.ts`) · **Category:** CORS / hardening
- **Protects:** the production fail-closed `superRefine` that rejects a wildcard CORS origin and forces an explicit allow-list.
- **Baseline:** a single `CORS_ORIGIN` (default `*`) governed both the REST app and the Socket.IO server, and was subject to the prod wildcard refusal (`989da1f:config.ts:41-45`).
- **Target status:** **WEAKENED.** A new `WIDGET_CORS_ORIGIN: z.string().default('*')` (`ef31b01:config.ts:27`) now governs the Socket.IO server (`index.ts:78-79` → `new SocketServer(httpServer, { cors: { origin: widgetCorsOrigin } })`), but the `superRefine` (`config.ts:46`) checks **only** `CORS_ORIGIN`. Verified: target test `config.test.ts` asserts "allows wildcard `WIDGET_CORS_ORIGIN` in production." So the socket handshake origin can be `*` in prod with no fail-closed guard.
- **Mitigation (by design, not removed):** the customer socket is still gated by the signed HS256 customer JWT (`index.ts` `createHs256Verifier(YIJI_JWT_SECRET)`), so origin is intentionally not the widget's auth boundary (the widget embeds on arbitrary vendor storefronts). `CORS_ORIGIN` (admin/AI REST + `/jobs/*`) retains the prod wildcard guard.
- **Impact:** reduced defense-in-depth against cross-site WebSocket hijacking / origin spoofing on the socket surface; no separate allow-list/strength assertion.
- **Severity:** MEDIUM — genuine relaxation of a prod hardening guard, but mitigated by JWT auth and arguably required by the embed model. Recommend an explicit allow-list option + a documented decision rather than silent `*`.

---

## LOW

### 6. `attachment:upload` — `decodeUploadContent` replaced by buggy inline decode

- **File:** `connection.ts` · **Category:** hardening / data-integrity
- **Baseline** (`989da1f:connection.ts:323`): `const buf = decodeUploadContent(data?.content);` — for an `ArrayBufferView` it copies **only the view window** (`Buffer.from(buf, byteOffset, byteLength)`).
- **Target status:** **WEAKENED.** Target inlines `buf = Buffer.from((data.content as ArrayBufferView).buffer)` — reading the **whole pooled `ArrayBuffer`**, ignoring `byteOffset`/`byteLength`. `decodeUploadContent` still exists in `attachments.ts:65` but is not called.
- **Impact:** not an auth bypass, but the documented buffer-slice corruption returns: uploads arriving as a Socket.IO buffer slice can be silently corrupted/expanded. (The empty-content rejection is preserved.)
- **Severity:** LOW — integrity/correctness, not a security control per se. **(Already remediated on the fix branch.)**

### 7. customer-jwt — contact-identifier requirement narrowed (phone-OR-email → phone-only)

- **File:** `customer-jwt.ts` · **Category:** validation
- **Baseline** (`989da1f:customer-jwt.ts:44-46`): `if (!parsed.data.phone && !parsed.data.email) throw 'token must include phone or email'`; `email: z.string().email().optional()`.
- **Target status:** **WEAKENED / CHANGED.** Target requires phone only (`ef31b01:customer-jwt.ts:58` `if (!parsed.data.phone?.trim()) throw …`) and wraps `email`/`name` in `z.preprocess(blankToUndefined, …)` so blank values normalize to `undefined`. Relocation check confirms the email branch of the requirement is gone, not moved.
- **Note:** the target comments make this **explicitly intentional** ("Phone is the ONLY mandatory contact identifier — the host guarantees it"). The **JWT signature verification core is unchanged** (HS256 pinned via `jwt.verify(token, secret, { algorithms: ['HS256'] })` — alg:none still prevented), so authentication strength is intact.
- **Impact:** narrows the identity-completeness guarantee; not an auth weakening.
- **Severity:** LOW — likely a deliberate product decision; flagged for confirmation, not necessarily a defect.

---

## Confirmed clean (no regressions) — verified, reported for assurance

- **`socket-gateway/src/directus.ts`** — diff is additive-only; all ownership/authorization controls **identical** across refs:
  - `deleteInternalNote` still re-reads the message and requires `conversation: { _eq: conversationId }` **and** `is_internal_note === true` before delete (IDOR + customer-message-deletion defense).
  - `upsertContact` dedup still scoped by `vendor: { _eq: vendorUuid }` (no cross-vendor dedup); blank identifiers normalized to `null` (a hardening _improvement_).
  - New methods (`getConversationAttachment`, `loadConversationMessages`, `getConversationStatus`) are **added and correctly conversation-scoped** (e.g. `messages_id: { conversation: { _eq: conversationId } }`, `is_internal_note: { _eq: false }`, `encodeURIComponent(fileId)`).
- **`socket-gateway/src/queue.ts`** — additive (new `enqueueImport`/`enqueueReport`); no control removed. New enqueue paths are gated by `requireAdmin` in `index.ts`.
- **`socket-gateway/src/index.ts`** — webhook HMAC verification (`x-yiji-signature` + `WEBHOOK_TOLERANCE_SEC`), security headers, raw-body retention, and `/jobs/*` admin gating (bearer → `validateAgentToken` → Admin role) all preserved; `/jobs/*` enforces an explicit origin allow-list. (The socket-CORS relaxation is attributed to finding #5.)
- **`socket-gateway` JWT core** — HS256 algorithm pinning (prevents alg:none) and production secret-strength assertions intact.
- **Entire `ai-gateway/src`** — **no regressions; strengthened:**
  - `auth/index.ts`: replaced static-token + spoofable `X-Yiji-Admin: 1`/`X-Yiji-User` headers with `verifyCaller()` that verifies the caller's real Directus token server-side and derives `isAdmin` from Directus roles (closes an admin self-grant hole).
  - `routes.ts`: every AI endpoint still gates on auth before zod validation; all three admin endpoints still enforce `isAdmin → 403`; rate-limit checks (per-IP/user/global/monthly) preserved.
  - `ratelimit/index.ts` and `redaction/index.ts`: **zero diff** — AI DoS protection and PII redaction perimeter (`redactDeep`) intact and still wired before the provider call.
  - `provider/gemini.ts`: output cap (`maxOutputTokens ?? 1024`) preserved; error handling improved (status-based, bounded retry).
  - `config.ts`: CORS prod wildcard-rejection retained; commerce key moved server-side (`YIJI_API_KEY`), removing the browser-exposed token.
  - `commerce/index.ts` (NEW): every route `requireAgent` (verified Directus session), param validation, `orders` limit clamped 1–50, read-only, Yiji key never reaches the browser.

---

## Recommendations (not implemented — analysis only)

1. **Restore the OPEN regressions** (2, 3, 5, 7) under review:
   - Re-add the customer IDOR binding to the `typing:start/stop` and `read/readAck` handlers (one-line guard each, mirroring the `message:send` fix).
   - Decide `WIDGET_CORS_ORIGIN`: keep `*` as a _documented_ exception (JWT is the boundary) **or** add a prod allow-list assertion; either way make the decision explicit in code + `deploy/README.md`.
   - Confirm finding #7 is an intended product change; if so, document it and close — otherwise restore the email-fallback identifier.
2. **Land the existing fix branch** (`fix/restore-socket-security-hardening`) which already closes 1, 4, 6 — then fold 2/3/5/7 into the same PR or a follow-up.
3. **Add a regression guard** in CI: flag exported security helpers (`sanitizeFilename`, `decodeUploadContent`, future ones) that have **no `src/` call sites** — would have caught the dead-code regressions automatically.
4. **Audit future stream merges** the way `ecd655c` should have been: a wholesale file overwrite from another stream must diff security-sensitive handlers against the secure baseline before merge.

---

### Verification trail

Per-file `git diff 989da1f ef31b01`; `git show 989da1f:<file>` / `git show ef31b01:<file>`; `git grep -n '<pattern>' ef31b01 -- services/<svc>` relocation checks for every "absent" claim. Findings 1, 4, 6 additionally cross-checked against the live handler code. Read-only; no files modified by this audit.
