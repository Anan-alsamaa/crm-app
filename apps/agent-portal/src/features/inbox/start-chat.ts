import { readItems } from '@directus/sdk';
import { SOCKET_EVENTS } from '@yiji/shared-types';
import { resolveUrl } from '@yiji/shared-config';
import { auth, directus } from '../../lib/directus.js';
import { getSocket } from '../../lib/socket.js';

/**
 * STARTING A CHAT WITH A CUSTOMER WHO HAS NOT WRITTEN TO US (EMA-10).
 *
 * The transport half of the compose dialog. Two calls, in this order, and the
 * order is the whole design:
 *
 *   1. `POST /chat/agent-initiate` resolves the CUSTOMER and the THREAD. It
 *      deliberately does not send anything.
 *   2. The agent's own socket sends the first message through the ORDINARY
 *      path — the one that already persists it, broadcasts it to the thread and
 *      enqueues the customer's push notification.
 *
 * A second implementation of "send a message" would drift from the first, and
 * the push enqueue is the half this feature exists for. Doing it this way also
 * means a failed send leaves the conversation intact: the agent lands in it
 * with their text still in the box, rather than losing both.
 */

/** Where the gateway's REST app lives — the same origin the socket uses. */
const GATEWAY_URL = resolveUrl(
  'SOCKET_URL',
  import.meta.env.VITE_SOCKET_URL,
  'http://localhost:8080',
);

export interface StartChatResult {
  conversationId: string;
  contactId: string;
  /** False when the customer already had a live thread the agent has joined. */
  created: boolean;
  /** True when this is the first time we have seen this person at all. */
  contactIsNew: boolean;
  name: string | null;
  phone: string;
}

/**
 * Is this number somebody we already know?
 *
 * Read straight from `contacts` with the agent's own token, so it answers with
 * what THEY are allowed to see — and so it needs no new endpoint. The number is
 * already canonical `05XXXXXXXX` by the time it gets here; every stored number
 * is that shape, which is what makes an exact match correct.
 */
export async function lookupContactByPhone(
  phone: string,
  /**
   * The CRM vendor the chat will be with (MV-4). Contacts are per vendor, so
   * with 2+ vendors the same number can be two different customers; naming
   * another vendor's customer here would greet the wrong person. Omitted with
   * one vendor — unchanged.
   */
  vendor?: string | null,
): Promise<{ id: string; name: string | null } | null> {
  const rows = (await directus.request(
    readItems(
      'contacts' as never,
      {
        filter: vendor
          ? { phone: { _eq: phone }, vendor: { _eq: vendor } }
          : { phone: { _eq: phone } },
        fields: ['id', 'name'],
        limit: 1,
      } as never,
    ),
  )) as unknown as Array<{ id: string; name: string | null }>;
  return rows[0] ?? null;
}

/**
 * Resolve the thread, then send the first message into it.
 *
 * THE SEND IS AWAITED, so the dialog can report a failure rather than closing
 * on an optimistic hope. `message:send` has no acknowledgement callback in this
 * codebase — the gateway echoes the message back on `message:new` — so the
 * promise settles on the echo, with a timeout that gives up rather than hanging
 * a dialog open for ever.
 */
export async function startChatWithCustomer(input: {
  phone: string;
  vendorId: string;
  message: string;
}): Promise<StartChatResult> {
  const token = await auth.getToken();
  const res = await fetch(`${GATEWAY_URL}/chat/agent-initiate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
    body: JSON.stringify({ phone: input.phone, vendorId: input.vendorId }),
  });

  const body = (await res.json().catch(() => null)) as
    | (StartChatResult & { ok: boolean; error?: string })
    | null;

  if (!res.ok || !body?.ok) {
    /*
     * THE GATEWAY'S OWN WORDS when it gave any — it distinguishes "not a
     * dialable phone number" from "unknown or inactive vendor" from "you do not
     * have permission", and an agent can act on each of those differently. A
     * generic failure would make all three look like the feature being broken.
     */
    throw new Error(body?.error || `could not start the conversation (${res.status})`);
  }

  await sendFirstMessage(body.conversationId, input.message);
  return body;
}

/** How long to wait for the gateway to echo the message back. */
const SEND_ECHO_TIMEOUT_MS = 10_000;

/**
 * Send the first message and wait for the gateway to confirm it.
 *
 * The socket is the SAME singleton the conversation view uses, so the thread
 * the agent is about to land in receives this message through its normal
 * subscription — no special case, and no second copy rendered.
 *
 * SUBSCRIBE FIRST. The agent has never had this conversation open, so their
 * socket is not in its room and would not receive the echo it is waiting for.
 */
async function sendFirstMessage(conversationId: string, content: string): Promise<void> {
  const socket = await getSocket();
  socket.emit(SOCKET_EVENTS.conversationSubscribe, { conversationId });

  const clientMsgId = `start_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      /*
       * THE CONVERSATION EXISTS EITHER WAY, so this is not "it failed" — it is
       * "we did not see it land". The dialog says so and leaves the agent in
       * the thread, where they can see for themselves whether it arrived.
       */
      reject(new Error('the message was sent but not confirmed — open the chat to check'));
    }, SEND_ECHO_TIMEOUT_MS);

    const onNew = (msg: { conversationId?: string; clientMsgId?: string }) => {
      /*
       * OUR message, in OUR conversation. `clientMsgId` is what makes this
       * precise: another agent replying in the same thread at the same moment
       * must not resolve this promise.
       *
       * CAMEL CASE — the gateway's `MessageNew` payload is `conversationId` /
       * `clientMsgId`, not the snake_case the Directus rows use. The two
       * spellings live side by side in this app and picking the wrong one here
       * would mean the echo never matches and every send times out.
       */
      if (msg?.conversationId !== conversationId) return;
      if (msg?.clientMsgId && msg.clientMsgId !== clientMsgId) return;
      cleanup();
      resolve();
    };
    /*
     * ONLY A PERSIST FAILURE, not every `error` the gateway emits.
     *
     * `SOCKET_EVENTS.error` is a general channel — a transport hiccup or a
     * failed retry arrives on it too, and treating any of them as a refusal is
     * the one-way door that once locked the composer on a chat that was working
     * perfectly. `persist_failed` is the only code that means "this message was
     * not stored"; anything else leaves the timeout to decide.
     */
    const onError = (err: { code?: string; message?: string }) => {
      if (err?.code !== 'persist_failed') return;
      cleanup();
      reject(new Error(err?.message || 'the gateway could not store the message'));
    };

    function cleanup() {
      clearTimeout(timer);
      /* NAMED handlers only. A bare `socket.off(event)` removes every listener
         for it, including the conversation view's — which is how a reply once
         stopped appearing in a chat that was open beside this dialog. */
      socket.off(SOCKET_EVENTS.messageNew, onNew);
      socket.off(SOCKET_EVENTS.error, onError);
    }

    socket.on(SOCKET_EVENTS.messageNew, onNew);
    socket.on(SOCKET_EVENTS.error, onError);
    socket.emit(SOCKET_EVENTS.messageSend, { conversationId, content, clientMsgId });
  });
}

/**
 * THE YIJI VENDOR ID, which is what `/chat/agent-initiate` expects.
 *
 * NOT the CRM uuid. `resolveVendor` on the gateway filters
 * `yiji_vendor_id _eq`, so handing it the row's own `id` — which is what
 * `useVendors` returns, and the obvious thing to reach for — answers 404
 * "unknown or inactive vendor" every single time, for a vendor that is right
 * there and active.
 *
 * Only an ACTIVE vendor, matching the gateway's own filter: offering to start a
 * chat against an inactive one would fail at the endpoint for a reason the
 * agent cannot see.
 *
 * Returns null when there is more than one, rather than guessing. Today every
 * environment has exactly one, and a wrong guess here sends a stranger a
 * message.
 */
export async function soleYijiVendorId(): Promise<string | null> {
  const rows = (await directus.request(
    readItems(
      'vendors' as never,
      {
        filter: { status: { _eq: 'active' } },
        fields: ['yiji_vendor_id'],
        limit: 2,
      } as never,
    ),
  )) as unknown as Array<{ yiji_vendor_id: string | null }>;
  if (rows.length !== 1) return null;
  return rows[0]?.yiji_vendor_id?.trim() || null;
}
