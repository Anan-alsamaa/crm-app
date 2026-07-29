# Critical Findings — Verification

**Date:** 2026-06-24
**Verified against:** `origin/001-yiji-crm-platform` @ `ef31b01b7bb3c35b648ae6bfc61e78def766be35` (the deployable integration branch), checked out in `crm-app-infra`.
**Method:** Read-only. Direct file reads + `git`/`grep` forensics. No code modified.

Each finding below is rated **CONFIRMED / PARTIALLY CONFIRMED / REFUTED**, with copy-runnable reproduction steps. A correction to the earlier reports' framing is included where the rigorous check changed the conclusion (see Finding 3 and §"Corrections").

| #   | Claim                                              | Verdict                                        | Exists on `001` today?                                                                |
| --- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `message:send` IDOR (no conversation binding)      | ✅ **CONFIRMED**                               | **Yes**                                                                               |
| 2   | Attachment upload bypasses decode/sanitize helpers | ✅ **CONFIRMED**                               | **Yes**                                                                               |
| 3   | `stream/frontend` not an ancestor of `001`         | ⚠️ **CONFIRMED (literal) — framing corrected** | Ancestor: true. The _important_ issue (hardening regression) is independently proven. |

---

## Finding 1 — `message:send` IDOR (write into any conversation)

**Claim:** The `message:send` socket handler persists and broadcasts to the client-supplied `conversationId` without verifying it belongs to the authenticated socket → a customer/agent can write into arbitrary conversations.

### Verdict: ✅ CONFIRMED — exists on `001` today.

### Evidence (exact lines)

**File:** `services/socket-gateway/src/connection.ts`

```
268  socket.on(SOCKET_EVENTS.messageSend, async (raw: unknown) => {
274    const parsed = MessageSend.safeParse(raw);
277    const { conversationId, content, attachments, clientMsgId } = parsed.data;   // ← from CLIENT payload
291    const senderType = data.kind === 'agent' ? 'agent' : 'customer';
292    const saved = await directus.persistMessage({
293      conversationId,                                                            // ← payload value, unchecked
294      senderType,
295      senderUser: data.kind === 'agent' ? data.agentId : undefined,
296      senderContact: data.kind === 'customer' ? data.contactId : undefined,
...
309    io.to(rooms.conversation(conversationId)).emit(SOCKET_EVENTS.messageNew, payload);  // ← broadcast to payload room
311    io.to(rooms.agentsAll()).emit(SOCKET_EVENTS.inboxActivity, { conversationId });
```

There is **no** check of `conversationId === data.conversationId` (customer) and **no** agent-assignment check anywhere in this handler. The authenticated conversation `data.conversationId` (set at connect for customers) is never consulted.

**Contrast — the CSAT handler in the same file IS bound** (proving the pattern was known but not applied here):

```
490    if (parsed.data.conversationId !== data.conversationId) return;
```

`grep -nE "conversationId !== data.conversationId" connection.ts` → **only line 490**.

**Schema does not scope** — `packages/shared-types/src/socket.ts:16-24`:

```
16  export const MessageSend = z
18      conversationId: idSchema,     // plain id; no ownership/scoping
21      content: z.string(),
22      attachments: z.array(z.string()).optional(),
23      clientMsgId: z.string(),
```

**Persistence layer does not scope** — `services/socket-gateway/src/directus.ts:149-167`:

```
149  async persistMessage(input: { conversationId: string; senderType; ... }) {
158    const created = await this.client.request(
159      createItem('messages', {
160        conversation: input.conversationId,   // ← blindly trusts the id; no membership check
```

### Impact

- **Customer** (`data.kind==='customer'`): can persist a message into _any_ `conversationId` and have it broadcast to that conversation's room (`rooms.conversation(...)`), reaching the legitimate agent(s)/customer there; it is also recorded with the attacker's `senderContact` (`data.contactId`) and fires `inboxActivity` to all agents. The attacker doesn't join the target room, so it's a **write/spoof**, not a read. (Severity: High.)
- **Agent** (`data.kind==='agent'`): can post into _any_ conversation regardless of assignment (`senderUser: data.agentId`). (Severity: High.)

### Reproduction steps

Static (definitive):

```bash
cd crm-app-infra && git checkout 001-yiji-crm-platform
sed -n '268,320p' services/socket-gateway/src/connection.ts     # handler uses payload conversationId, no binding
grep -nE "conversationId !== data.conversationId" services/socket-gateway/src/connection.ts   # → only :490 (CSAT)
sed -n '149,167p' services/socket-gateway/src/directus.ts        # persistMessage has no membership check
```

Dynamic (against a running gateway): connect as customer A (handshake JWT → `data.conversationId = convA`); emit `message:send` with `{ conversationId: convB, content: "x", clientMsgId: "1" }` where `convB` belongs to another customer; observe the message persisted to `convB` and delivered to `convB`'s room.

### When introduced

The guard **was present** in `001` after PR #27 and was **removed by the PR #29 merge** — see Finding 3 for the proof (`1 → 0` guard hits across merge commit `ecd655c`).

---

## Finding 2 — Attachment upload bypasses the corruption-safe decode + filename sanitizer

**Claim:** `attachment:upload` decodes bytes with a raw `Buffer.from((view).buffer)` (ignoring `byteOffset`/`byteLength`) and never sanitizes the filename, instead of using the `decodeUploadContent`/`sanitizeFilename` helpers that exist for exactly this.

### Verdict: ✅ CONFIRMED — exists on `001` today.

### Evidence (exact lines)

**The helpers exist** — `services/socket-gateway/src/attachments.ts`:

```
40  export function sanitizeFilename(input: unknown): string {
65  export function decodeUploadContent(content: unknown): Buffer | null {
92  export function validateAttachments(
```

**They are NOT imported into the handler** — `services/socket-gateway/src/connection.ts:20`:

```
20  import { validateAttachments, type AttachmentPolicy } from './attachments.js';
```

`grep -nE "decodeUploadContent|sanitizeFilename" connection.ts` → **no matches** (0 hits).

**The upload handler uses the raw/unsafe path** — `services/socket-gateway/src/connection.ts:329-344`:

```
329  socket.on('attachment:upload', async (raw, ack) => {
333    const filename = typeof data?.filename === 'string' ? data.filename : 'upload';   // ← no sanitizeFilename
335    let buf: Buffer | null = null;
336    if (data?.content instanceof ArrayBuffer) buf = Buffer.from(data.content);
337    else if (ArrayBuffer.isView(data?.content as ArrayBufferView))
338      buf = Buffer.from((data.content as ArrayBufferView).buffer);                    // ← ignores byteOffset/byteLength
339    else if (typeof data?.content === 'string') buf = Buffer.from(data.content, 'base64');
```

### Why it matters

- **Corruption (line 338):** `Buffer.from(view.buffer)` copies the _entire backing ArrayBuffer_, ignoring the view's `byteOffset`/`byteLength`. Socket.IO/engine.io binary frames are frequently views into a larger pooled buffer, so the uploaded bytes can be wrong (extra/incorrect bytes). `decodeUploadContent` (attachments.ts:65) was written specifically to honor offset/length. (`ArrayBuffer` and base64 inputs are unaffected; the typed-array branch is the risk.)
- **Unsanitized filename (line 333):** the client filename is passed straight to `directus.uploadFile(...)` with no `sanitizeFilename`.

Note: the related `attachment:get` path (connection.ts:361-375) **is** correctly conversation-scoped (`directus.getConversationAttachment(data.conversationId, fileId)`), so this finding is upload-integrity/sanitization, not an attachment IDOR.

### Reproduction steps

```bash
cd crm-app-infra && git checkout 001-yiji-crm-platform
grep -nE "decodeUploadContent|sanitizeFilename" services/socket-gateway/src/attachments.ts   # helpers exist (:40,:65)
grep -nE "decodeUploadContent|sanitizeFilename" services/socket-gateway/src/connection.ts     # → no matches (not used)
sed -n '329,344p' services/socket-gateway/src/connection.ts                                    # raw Buffer.from + raw filename
```

### When introduced

Same regression as Finding 1: decode/sanitize usage in `connection.ts` went **`4 → 0` hits** across the PR #29 merge (see Finding 3).

---

## Finding 3 — `stream/frontend` is not an ancestor of `001`

**Claim (as originally stated):** `stream/frontend` is not an ancestor of `001`, and hardening present on the streams is missing from `001`.

### Verdict: ⚠️ CONFIRMED literally — **but the original framing was imprecise and is corrected here.**

### What is literally true

```bash
cd crm-app-infra && git fetch origin
git merge-base --is-ancestor origin/stream/frontend origin/001-yiji-crm-platform; echo $?   # → 1 (NOT an ancestor)
git rev-list --count origin/001-yiji-crm-platform..origin/stream/frontend                   # → 1
git log --oneline origin/001-yiji-crm-platform..origin/stream/frontend
#   7c46921 fix(deploy): no-cache the portal SPA shell in the container images
```

So `stream/frontend` is **not** an ancestor — but only because of **one trivial deploy commit** (`7c46921`, SPA no-cache) added _after_ its PR merged. **The frontend work did land:** PR #29's head `d87e9c0` **is** an ancestor of `001` (`git merge-base --is-ancestor d87e9c0 origin/001` → 0).

➡️ **Correction:** the "not an ancestor" fact is real but **not meaningful on its own** — it does not indicate dropped frontend work. The earlier report leaned on it as evidence of the hardening loss; that inference was wrong.

### What is the _real_, proven issue (and it is worse/more specific)

The hardening (message:send guard + decode/sanitize) lives on **`stream/quality`** and **`stream/infra`** — **not** on `stream/frontend` — and the **PR #29 merge reverted it in `001`.**

Guard / decode-sanitize presence per branch (`grep -c` on `connection.ts`):

```
origin/001-yiji-crm-platform :  msg-send-guard 0   decode/sanitize 0
origin/stream/quality        :  msg-send-guard 1   decode/sanitize 2
origin/stream/infra          :  msg-send-guard 1   decode/sanitize 4
origin/stream/frontend       :  msg-send-guard 0   decode/sanitize 0     ← never had it
```

Origin of the hardening: commit `989da1f "security: fix customer IDOR + harden uploads, AI DoS, and the prod edge"`.

**The merge that dropped it — PR #29 (`ecd655c`):**

```
ecd655c^1  435702a  "Merge PR #27 …"   (001 BEFORE #29):  guard=1  decode/sanitize=4   ✅ hardened
ecd655c^2  d87e9c0  (frontend side)  :                    guard=0                       ✗ no guard
ecd655c    (001 AFTER #29 = shipped):                     guard=0                       ✗ REVERTED
```

i.e. PR #29's conflict resolution on `connection.ts` took the frontend side (which lacked the guard) and overwrote the hardened version PR #27 had already merged. This is the precise mechanism behind Findings 1 & 2.

### Reproduction steps

```bash
cd crm-app-infra && git fetch origin
# branch presence:
for b in origin/001-yiji-crm-platform origin/stream/quality origin/stream/infra origin/stream/frontend; do
  echo "$b: $(git show $b:services/socket-gateway/src/connection.ts | grep -c 'conversation not accessible')"
done
# the regressing merge:
git show ecd655c^1:services/socket-gateway/src/connection.ts | grep -c 'conversation not accessible'   # 1 (before)
git show ecd655c^2:services/socket-gateway/src/connection.ts | grep -c 'conversation not accessible'   # 0 (frontend)
git show ecd655c:services/socket-gateway/src/connection.ts   | grep -c 'conversation not accessible'   # 0 (after)
```

---

## Corrections to the earlier reports (`project-risk-assessment.md`, `session-memory-export.md`)

Rigorous verification changed two framings — recorded here for honesty:

1. **"Hardening exists on the streams (incl. stream/frontend) but not 001."** → Corrected: the hardening exists on **stream/quality + stream/infra only**; **stream/frontend never had it**. An earlier session note claiming frontend's `connection.ts` had the guard "at line 379" was **mistaken**.
2. **"`stream/frontend` not an ancestor of 001" presented as evidence of dropped work.** → Corrected: that status is caused by one trivial post-merge commit; the frontend PR did land. The actual cause of the missing hardening is the **PR #29 merge reverting `connection.ts`** (proven above), not an un-merged branch.

**Net effect on the headline conclusion: unchanged and, if anything, stronger.** `001` — the deployable branch — ships **without** the customer-IDOR guard and **without** the upload decode/sanitize hardening, and we now have the exact commit (`ecd655c`) and mechanism that removed them. Findings 1 and 2 are confirmed present today; the remediation is to re-apply the `connection.ts` hardening from `989da1f` onto `001` (cherry-pick the relevant hunks or re-merge `connection.ts` from `stream/infra`).

---

## Severity (re-affirmed)

| Finding                           | Severity              | Rationale                                                                                                           |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1 — `message:send` IDOR           | 🟠 **High**           | Authenticated-but-cross-conversation write/spoof + agent-into-any-conversation; persisted and broadcast to victims. |
| 2 — upload decode/sanitize bypass | 🟡 **Medium**         | Byte-corruption risk for typed-array uploads + unsanitized filenames; not an IDOR (retrieval is scoped).            |
| 3 — convergence regression        | 🟠 **High (process)** | A green, "merged" PR silently reverted a landed security fix; undetected because no test covers the IDOR.           |

---

_Read-only verification. No source files modified. All line numbers and hashes are valid as of `001` = `ef31b01`, 2026-06-24._
