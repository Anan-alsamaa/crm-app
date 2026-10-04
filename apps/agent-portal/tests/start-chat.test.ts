import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AN AGENT OPENS A CHAT WITH A CUSTOMER WHO HAS NOT WRITTEN TO US (EMA-10).
 *
 * The UI half of EMA-9. Asserted against the source: the dialog needs a
 * QueryClient, i18n, an auth context and a live socket to mount, and mocking
 * all four to observe two network calls would be testing the mocks.
 *
 * What is pinned here is the handful of decisions that are invisible in a
 * screenshot and expensive to get wrong.
 */
const CLIENT = readFileSync(
  resolve(import.meta.dirname, '../src/features/inbox/start-chat.ts'),
  'utf8',
);
const DIALOG = readFileSync(
  resolve(import.meta.dirname, '../src/features/inbox/StartChatDialog.tsx'),
  'utf8',
);
const INBOX = readFileSync(resolve(import.meta.dirname, '../src/pages/Inbox.tsx'), 'utf8');

/**
 * THE VENDOR ID IS YIJI'S, NOT THE CRM'S.
 *
 * `/chat/agent-initiate` resolves the vendor with
 * `filter: { yiji_vendor_id: { _eq: … } }`, while `useVendors` — the obvious
 * hook to reach for, and the one every other form uses — returns the row's own
 * uuid. MEASURED against staging before this shipped:
 *
 *   CRM uuid `f227c4ca-…`  -> 404 {"error":"unknown or inactive vendor"}
 *   Yiji id  `1`           -> 200 {"ok":true,…}
 *
 * The wrong one fails on every single attempt, for a vendor that is right there
 * and active — a dead feature that typechecks. This is the trap, so this is the
 * test.
 */
describe('which vendor id reaches the endpoint', () => {
  it('reads yiji_vendor_id, not the row id', () => {
    expect(CLIENT).toMatch(/fields: \['yiji_vendor_id'\]/);
    expect(CLIENT).toMatch(/rows\[0\]\?\.yiji_vendor_id/);
  });

  /* Only an ACTIVE vendor, matching the gateway's own filter — offering to
     start a chat against an inactive one would fail at the endpoint for a
     reason the agent cannot see. */
  it('only considers an active vendor', () => {
    expect(CLIENT).toMatch(/filter: \{ status: \{ _eq: 'active' \} \}/);
  });

  /* Null rather than a guess when there is more than one. A wrong guess here
     sends a stranger a message. */
  it('refuses to guess when there is more than one vendor', () => {
    expect(CLIENT).toMatch(/if \(rows\.length !== 1\) return null/);
    expect(CLIENT).toMatch(/limit: 2/);
  });
});

/**
 * TWO CALLS, IN THIS ORDER.
 *
 * The endpoint resolves the customer and the thread and deliberately does NOT
 * send anything; the agent's own socket sends through the ordinary path, which
 * already persists, broadcasts and enqueues the customer's push. A second
 * implementation of "send a message" would drift from the first, and the push
 * enqueue is the half this feature exists for.
 */
describe('resolve first, then send', () => {
  it('calls the endpoint and then sends over the socket', () => {
    expect(CLIENT).toContain('/chat/agent-initiate');
    expect(CLIENT).toMatch(/await sendFirstMessage\(body\.conversationId, input\.message\)/);
  });

  /* SUBSCRIBE FIRST: the agent has never had this conversation open, so their
     socket is not in its room and would never receive the echo it waits for. */
  it('joins the conversation room before sending', () => {
    const fn = CLIENT.slice(CLIENT.indexOf('async function sendFirstMessage'));
    const sub = fn.indexOf('conversationSubscribe');
    const send = fn.indexOf('messageSend');
    expect(sub).toBeGreaterThan(-1);
    expect(sub).toBeLessThan(send);
  });

  /*
   * THE ECHO IS CAMEL CASE. The gateway's `MessageNew` payload is
   * `conversationId` / `clientMsgId`, not the snake_case the Directus rows use.
   * Both spellings live in this app, and the wrong one here means the echo
   * never matches and every send times out — a feature that looks broken while
   * working perfectly.
   */
  it('matches the echo on the payload the gateway actually sends', () => {
    expect(CLIENT).toMatch(/msg\?\.conversationId !== conversationId/);
    expect(CLIENT).toMatch(/msg\?\.clientMsgId && msg\.clientMsgId !== clientMsgId/);
    expect(CLIENT).not.toMatch(/msg\?\.conversation_id/);
  });

  /*
   * ONLY `persist_failed` IS A REFUSAL.
   *
   * `SOCKET_EVENTS.error` is a general channel — a transport hiccup or a failed
   * retry arrives on it too, and treating any of them as a refusal is the
   * one-way door that once locked the composer on a chat that was working.
   */
  it('does not treat every socket error as a refusal', () => {
    expect(CLIENT).toMatch(/if \(err\?\.code !== 'persist_failed'\) return/);
  });

  /* NAMED handlers. A bare `socket.off(event)` removes every listener for it,
     including the conversation view's — which is how a reply once stopped
     appearing in a chat open beside this dialog. */
  it('removes only its own listeners', () => {
    expect(CLIENT).toMatch(/socket\.off\(SOCKET_EVENTS\.messageNew, onNew\)/);
    expect(CLIENT).toMatch(/socket\.off\(SOCKET_EVENTS\.error, onError\)/);
  });

  /* A hung send must not hold the dialog open for ever. */
  it('gives up rather than hanging', () => {
    expect(CLIENT).toMatch(/SEND_ECHO_TIMEOUT_MS/);
    expect(CLIENT).toMatch(/clearTimeout\(timer\)/);
  });
});

describe('who the agent is about to message', () => {
  /* Resolved on BLUR: a partial number matches nobody, so per-keystroke
     lookups are a request per character for an answer that is wrong until the
     last one. */
  it('looks the customer up when the field loses focus', () => {
    expect(DIALOG).toMatch(/onBlur=\{\(\) => void check\(\)\}/);
  });

  /* Any edit invalidates what we knew — a name on screen must never belong to
     a different number than the one in the box. */
  it('clears the result as soon as the number changes', () => {
    const onChange = DIALOG.slice(DIALOG.indexOf('setPhone(e.target.value)'));
    expect(onChange.slice(0, 300)).toMatch(/setLookup\(\{ state: 'idle' \}\)/);
  });

  /*
   * A FAILED LOOKUP SAYS NOTHING — it must not render as "new customer". That
   * would be a confident lie about somebody the company already knows, and the
   * agent can still send either way.
   */
  it('does not call an unresolved customer new', () => {
    expect(DIALOG).toMatch(/state: 'unknown'/);
    expect(DIALOG).toMatch(/`idle` \(not checked yet\) and `unknown`/);
  });

  /* The number is canonical before anything looks it up: `+966 50 …` and
     `050 …` are the same person, and an unnormalised lookup would miss the
     contact and invite a duplicate. */
  it('normalises the number before matching', () => {
    expect(DIALOG).toMatch(/const canonical = normalizePhone\(phone\)/);
    expect(CLIENT).toMatch(/filter: \{ phone: \{ _eq: phone \} \}/);
  });
});

describe('the inbox entry point', () => {
  it('offers a + button beside the search box', () => {
    expect(INBOX).toMatch(/onClick=\{\(\) => setComposing\(true\)\}/);
    expect(INBOX).toContain('inbox.startChat.title');
  });

  /* THE SAME PAGE. The spec is explicit that there is no navigation away, and
     the inbox already renders the selected conversation beside the list. */
  it('opens the new chat in place rather than navigating', () => {
    const mount = INBOX.slice(INBOX.indexOf('<StartChatDialog'));
    expect(mount).toMatch(/setSelected\(conversationId\)/);
    expect(mount).not.toMatch(/navigate\(/);
  });

  /* The chat is brand new, so the list query has never seen it — without this
     the thread opens beside a list that does not contain it. */
  it('refreshes the conversation list', () => {
    const mount = INBOX.slice(INBOX.indexOf('<StartChatDialog'));
    expect(mount).toMatch(/invalidateQueries\(\{ queryKey: \['conversations'\] \}\)/);
  });
});
