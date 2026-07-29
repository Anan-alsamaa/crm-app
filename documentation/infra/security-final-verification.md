# Security Final Verification — Infra remediation branch

**Branch reviewed:** `fix/restore-socket-security-hardening` (local; **not pushed to origin**)
**Commit:** `dafbba7` — "fix(gateway): restore security hardening dropped by merge ecd655c"
**Base:** `origin/001-yiji-crm-platform` @ `ef31b01` (1 commit ahead)
**Secure baseline compared against:** `989da1f` / `origin/stream/infra`
**Method:** read-only static review + git/grep forensics. No code modified.

---

## ⛔ VERDICT: **FAIL**

The branch correctly restores **3 of the 7** requested fixes (`message:send` IDOR, `sanitizeFilename`, `decodeUploadContent`) and introduces **no regression**. However, **4 of the 7** are not delivered: **`typing:start`, `typing:stop`, and `read:ack` remain exploitable** (no customer↔conversation binding), and `read` is only partially mitigated. These guards **exist in the secure baseline** the branch claims to restore from (`stream/infra` lines 532, 546) but were **not** brought back. Tests prove only `message:send`. The remediation is **incomplete** versus both the requested scope and its own stated source of truth.

| #   | Requested fix                        | Status           | Evidence                                                                |
| --- | ------------------------------------ | ---------------- | ----------------------------------------------------------------------- |
| 1   | `message:send` IDOR                  | ✅ **Fixed**     | guard `connection.ts:289-293`                                           |
| 2   | `typing:start` IDOR                  | ❌ **Not fixed** | `connection.ts:467-476` — no guard                                      |
| 3   | `typing:stop` IDOR                   | ❌ **Not fixed** | same loop `connection.ts:467-476` — no guard                            |
| 4   | `read` IDOR (`markConversationRead`) | ⚠️ **Partial**   | agent-gated `:484`, but not conversation-bound                          |
| 5   | `read:ack` IDOR (broadcast)          | ❌ **Not fixed** | `connection.ts:489-491` — broadcasts to payload conv, no customer guard |
| 6   | attachment `sanitizeFilename`        | ✅ **Fixed**     | `connection.ts:350`                                                     |
| 7   | attachment `decodeUploadContent`     | ✅ **Fixed**     | `connection.ts:352-353`                                                 |

| Confirmation                    | Result                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| No bypass exists                | ❌ **FAIL** — typing:start / typing:stop / read:ack cross-conversation spoof remain |
| No regression introduced        | ✅ **PASS** — additive change; happy-path covered; attachment path intact           |
| Tests correctly prove the fixes | ❌ **FAIL** — only `message:send` is tested; items 2-5 have neither fix nor test    |

---

## Per-item verification

### 1. `message:send` IDOR — ✅ FIXED

`services/socket-gateway/src/connection.ts:289-293`:

```ts
if (data.kind === 'customer' && conversationId !== data.conversationId) {
  return socket.emit(SOCKET_EVENTS.error, {
    code: 'forbidden',
    message: 'conversation not accessible',
  });
}
```

Inserted after payload parse (`:280`), before `persistMessage` (`:308`). Correctly constrains **customers** only (agents operate the shared inbox by design). Matches the secure baseline. **No bypass:** the payload `conversationId` cannot reach `persistMessage`/broadcast for a customer whose handshake conversation differs.

### 2 & 3. `typing:start` / `typing:stop` IDOR — ❌ NOT FIXED

`services/socket-gateway/src/connection.ts:467-476`:

```ts
for (const evt of [SOCKET_EVENTS.typingStart, SOCKET_EVENTS.typingStop] as const) {
  socket.on(evt, (raw: unknown) => {
    const parsed = TypingSignal.safeParse(raw);
    if (!parsed.success) return;
    socket.to(rooms.conversation(parsed.data.conversationId)).emit(SOCKET_EVENTS.typingUpdate, {
      conversationId: parsed.data.conversationId, // ← PAYLOAD value, unguarded
      who: data.kind,
      isTyping: evt === SOCKET_EVENTS.typingStart,
    });
  });
}
```

There is **no** `data.kind === 'customer' && parsed.data.conversationId !== data.conversationId` check. A customer can emit `typing:start`/`typing:stop` with any `conversationId` and broadcast a spoofed typing indicator into that conversation's room (`socket.to(room)` emits regardless of sender membership).
**Baseline has the guard** — `origin/stream/infra:services/socket-gateway/src/connection.ts:532`:

```ts
if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;
```

**This guard was dropped by `ecd655c` and not restored.**

### 4. `read` IDOR (`markConversationRead`) — ⚠️ PARTIAL

`services/socket-gateway/src/connection.ts:484-488`:

```ts
if (data.kind === 'agent') {
  directus.markConversationRead(parsed.data.conversationId).catch(...);
}
```

The DB read-reset is **agent-only**, so a customer cannot reset another conversation's unread counter — a real mitigation. **But** it is not conversation-bound (the baseline's single early-return guard at `:546` protected this path too), and it shares the unguarded broadcast below. Not restored to the baseline shape.

### 5. `read:ack` IDOR (broadcast) — ❌ NOT FIXED

`services/socket-gateway/src/connection.ts:489-491`:

```ts
socket.to(rooms.conversation(parsed.data.conversationId)).emit(SOCKET_EVENTS.readAck, parsed.data);
```

No customer guard → a customer can broadcast a spoofed `read:ack` into **any** conversation room.
**Baseline has the guard** — `origin/stream/infra:...connection.ts:546`:

```ts
if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;
```

**Dropped by `ecd655c`, not restored.**

### 6. attachment `sanitizeFilename` — ✅ FIXED

Imported `connection.ts:22`; used `connection.ts:350` `const filename = sanitizeFilename(data?.filename);` and passed to `directus.uploadFile(buf, filename, mimetype)` (`:359`). Restores path-traversal / control-char / bidi-override / length protection.

### 7. attachment `decodeUploadContent` — ✅ FIXED

Imported `connection.ts:23`; used `connection.ts:352` `const buf = decodeUploadContent(data?.content);` with a null-check `:353`. Replaces the corrupting inline `Buffer.from((view).buffer)` (which ignored `byteOffset`/`byteLength`). MIME allow-list + size cap preserved (`:354-356`). Faithful, correct.

---

## Confirmations

### No bypass exists — ❌ FAIL

- `message:send` (1): no bypass — verified the guard precedes persist/broadcast and the schema/persistence don't reintroduce the payload id for customers.
- Attachments (6,7): no bypass on upload integrity/sanitization; `attachment:get` remains conversation-scoped (`:374-389`).
- **`typing:start`, `typing:stop`, `read:ack` (2,3,5): live bypass.** A customer socket bound to conversation A can emit these with `conversationId = B` and the gateway broadcasts into B's room. Low individual impact (cosmetic spoof of typing/read state) but it is exactly the IDOR class in scope, and was guarded in the baseline.

### No regression introduced — ✅ PASS

- `dafbba7` is purely additive to `connection.ts` (29 insertions / 8 deletions — the deletions are the inline decode replaced by helper calls). No feature handlers removed.
- Happy-path preserved and tested: "message:send from a customer into its OWN conversation still persists" passes.
- Attachment upload still validates MIME + size and uploads identically.
- No change to agent flows, presence, history, or `attachment:get`.

### Tests correctly prove the fixes — ❌ FAIL

The branch adds **two** tests to `services/socket-gateway/tests/connection.test.ts` (lines 304-335), both for **`message:send`**:

1. _"message:send from a customer is REJECTED when targeting another conversation (IDOR)"_ — asserts `code === 'forbidden'` and `persistMessage` not called. ✅ proves item 1.
2. _"message:send from a customer into its OWN conversation still persists"_ — proves no regression on the happy path. ✅

There are **no tests** for `typing:start`, `typing:stop`, `read`, or `read:ack` (consistent with the fixes being absent). The attachment restorations (6,7) have **no connection-level test** on this branch asserting the handler now _calls_ the helpers — the helpers are unit-tested in `attachments.test.ts`, which proves the helpers work, not that `connection.ts` is wired to them. (A wiring/integration test would catch a future re-drop, which is the exact failure mode that occurred via `ecd655c`.)

---

## Why this happened (root-cause note)

`ecd655c` (Merge PR #29) dropped **five** customer-binding hardenings from `connection.ts`, not three:

- `message:send` guard, `typing:start`/`typing:stop` guard (shared loop), `read:ack` guard, plus `sanitizeFilename` + `decodeUploadContent` call sites. (`csat` survived.)
- Evidence: `git show ecd655c^1:...connection.ts | grep -c 'parsed.data.conversationId !== data.conversationId'` → **3** (typing, readAck, csat) before the merge; current `001` retains only `csat`. The baseline `stream/infra` has the typing + readAck guards at `:532` and `:546`.

Infra's own `documentation/security-regression-remediation.md` enumerates **only three** lost hardenings (its evidence table omits `typing`/`read:ack`), so the restore faithfully fixed what that doc scoped — but that scope **under-counted the regression**. This is why the branch is internally consistent yet still fails the 7-item requirement.

---

## Required to reach PASS

1. Restore the customer-binding guard to the typing loop (mirror baseline `stream/infra:532`):
   `if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;` inside `connection.ts:468`.
2. Restore the same guard to the `read:ack` handler (baseline `:546`) at `connection.ts:480`, covering both `markConversationRead` and the broadcast.
3. Add tests proving items 2-5 reject a cross-conversation customer and still allow the own-conversation/agent path.
4. Add a wiring assertion that `attachment:upload` rejects/normalizes a path-traversal filename and correctly decodes an offset buffer slice (guards against a future re-drop of items 6-7).
5. Re-run `pnpm exec vitest run services/socket-gateway` and re-verify against this checklist.

Simplest correct path: re-merge `services/socket-gateway/src/connection.ts` from `989da1f`/`stream/infra` wholesale (it contains all five guards in their tested form) rather than re-applying three by hand.

---

_Read-only verification. No source modified. Lines valid as of `fix/restore-socket-security-hardening` @ `dafbba7`; baseline `origin/stream/infra`; regression merge `ecd655c`. 2026-06-24._
