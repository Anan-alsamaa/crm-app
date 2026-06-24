# Security Remediation — Phase 2 (typing / read IDOR guards)

> **Date:** 2026-06-24 · **Branch:** `fix/socket-idor-typing-read-phase2` (off `fix/restore-socket-security-hardening` @ `dafbba7`, which is off `001-yiji-crm-platform` @ `ef31b01`). · **Status:** implemented, tests green, **NOT merged**.
> **Closes:** OPEN findings **#2** and **#3** from `documentation/security-convergence-audit.md`.
> Continues the work in `documentation/security-regression-remediation.md` (Phase 1 closed findings #1/#4/#6).

---

## 1. Scope

Phase 1 restored the `message:send` IDOR guard (CRITICAL) plus the attachment `sanitizeFilename` / `decodeUploadContent` usages. The convergence audit then found the **same customer→conversation IDOR-binding pattern was also dropped from two more handlers**:

| #   | Handler                        | Finding                                                         | Severity |
| --- | ------------------------------ | --------------------------------------------------------------- | -------- |
| 2   | `typing:start` / `typing:stop` | customer can spoof typing indicators into any conversation room | MEDIUM   |
| 3   | `read:ack`                     | customer can spoof read receipts into any conversation room     | MEDIUM   |

Both are now restored. **No unrelated functionality was modified** — each change is a single guard line mirroring the secure baseline `989da1f` and the Phase-1 `message:send` fix.

---

## 2. What changed

### Validation pattern (identical predicate to `message:send`)

Both handlers now drop a customer event whose payload `conversationId` does not match the conversation the socket was bound to at handshake (`data.conversationId`):

```ts
if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;
```

**Action = silent `return`** (not an error emit). This is deliberate and matches the secure baseline `989da1f` for these handlers:

- `typing:*` and `read:ack` are **fire-and-forget ephemeral signals**; the baseline dropped a spoofed signal silently.
- `message:send` (a write) emits `code: 'forbidden'` so the client can roll back optimistic UI — appropriate there, but emitting an error on every spoofed typing/read event would change client error-handling behavior (the widget treats some `error` codes specially). Silent drop is the faithful, non-disruptive convergence. The **validation predicate is exactly the same** as `message:send`; only the post-rejection action differs, per the baseline.

### `services/socket-gateway/src/connection.ts`

- **`typing:start` / `typing:stop`** handler (the `for (const evt of [typingStart, typingStop])` loop): added the guard after `safeParse`, before the `typing:update` broadcast.
- **`read:ack`** handler: added the guard after `safeParse`, before the `markConversationRead` side-effect and the `read:ack` broadcast.

### `services/socket-gateway/tests/connection.test.ts`

- Added `expectNoEvent(client, event, ms)` helper — resolves iff the event is **not** received within the window (rejects if it arrives).
- Added `agentSubscribedTo(conversationId)` helper — connects an agent and joins it to a foreign conversation room via `conversation:subscribe`, to act as the listener that must receive nothing.
- Added two regression tests in the existing `typing + read signals between two parties` describe:
  - `typing:start from a customer into ANOTHER conversation is dropped (IDOR)`
  - `read:ack from a customer into ANOTHER conversation is dropped (IDOR)`

The pre-existing positive-control tests (`typing:start ... reaches the other in the same conversation`, `read:ack is forwarded to the rest of the conversation room`) remain green, proving the guard does **not** over-block legitimate same-conversation signals.

---

## 3. Test results

Run from the `crm-app-infra` worktree on `fix/socket-idor-typing-read-phase2`:

- **Typecheck:** `pnpm exec tsc --noEmit` (socket-gateway) → **exit 0**.
- **Full socket-gateway suite:** `pnpm exec vitest run services/socket-gateway` → **14 files / 121 tests passed** (was 119; +2). `connection.test.ts` now **26 tests** (was 24).
- **Mutation check (test validity):** with the typing guard temporarily removed, `typing:start ... is dropped (IDOR)` **FAILS** with `unexpected typing:update received` — confirming the test genuinely catches the regression and is not vacuous. Guard restored; suite re-run green (121).

```
 ✓ services/socket-gateway/tests/connection.test.ts (26 tests)
 ... (13 more files)
 Test Files  14 passed (14)
      Tests  121 passed (121)
```

---

## 4. Exact files changed (Phase 2)

| File                                               | Change                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `services/socket-gateway/src/connection.ts`        | +2 guard lines (1 in the typing loop, 1 in the read:ack handler) + their `// IDOR guard` comments |
| `services/socket-gateway/tests/connection.test.ts` | +`expectNoEvent` helper, +`agentSubscribedTo` helper, +2 IDOR regression tests                    |
| `documentation/security-remediation-phase2.md`     | this report                                                                                       |

> This branch is stacked on Phase 1, so it also carries the Phase-1 commit (`dafbba7`: message:send IDOR + sanitizeFilename + decodeUploadContent). The Phase-2 delta is only the three files above.

---

## 5. Status / remaining OPEN findings

- **NOT merged**, per instruction. Local branch only; not pushed.
- After Phase 2, the convergence-audit findings stand as:
  - #1 message:send IDOR — ✅ (Phase 1)
  - #2 typing IDOR — ✅ (Phase 2)
  - #3 read IDOR — ✅ (Phase 2)
  - #4 sanitizeFilename — ✅ (Phase 1)
  - #6 decodeUploadContent — ✅ (Phase 1)
  - **#5 `WIDGET_CORS_ORIGIN` wildcard exemption — ❌ STILL OPEN** (needs a product decision: documented `*` exception vs prod allow-list assertion).
  - **#7 customer-jwt identifier narrowing — ❌ OPEN** (likely intentional; needs confirmation, not necessarily a fix).
- Recommended next: land Phase 1 + Phase 2 together as one PR into `001-yiji-crm-platform` after review; handle #5/#7 as explicit decisions.
