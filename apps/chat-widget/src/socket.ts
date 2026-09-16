import { io, type Socket } from 'socket.io-client';

/**
 * Widget socket connection (T051). Connects to the gateway with the Yiji JWT,
 * with automatic reconnect + exponential backoff (handled by Socket.IO's
 * reconnection, tuned here).
 */
export interface WidgetMessage {
  id: string;
  conversationId: string;
  senderType: 'customer' | 'agent' | 'system';
  content: string;
  attachments: string[];
  createdAt: string;
  clientMsgId?: string;
  /**
   * Delivery state of a message THIS device sent. Absent on anything received.
   *
   * `sending` until the gateway echoes it back, `sent` once it has, `failed`
   * when the send was refused or timed out. Before this existed a failed send
   * looked identical to a delivered one — the bubble appeared and simply never
   * arrived, with nothing on screen saying so and no way to retry.
   */
  status?: 'sending' | 'sent' | 'failed';
}

export interface SocketCallbacks {
  onReady: (info: {
    /**
     * null on a brand-new session: the conversation is not created until the
     * customer actually sends something, so there is nothing to name yet.
     * `onConversationReady` delivers the real id at that moment.
     */
    conversationId: string | null;
    branding: unknown;
    agentsOnline: number;
    /** The vendor the customer is talking to — the "Powered by" line names them. */
    vendorName?: string | null;
    /** The customer's own name/phone + whether this is their first-ever contact
     *  — lets the widget greet a returning customer by name. */
    contact?: { name: string | null; phone: string | null };
    isNew?: boolean;
  }) => void;
  onMessage: (msg: WidgetMessage) => void;
  /** Existing thread pushed by the gateway on (re)connect, so a returning
   *  customer sees their history instead of a blank panel. */
  onHistory?: (messages: WidgetMessage[]) => void;
  onTyping: (isTyping: boolean) => void;
  onStatus: (status: 'connecting' | 'connected' | 'reconnecting' | 'error') => void;
  /** The customer's most recent Yiji order id, when there is one. */
  onLatestOrder?: (orderId: string) => void;
  /**
   * The gateway refused something — a rate limit, a bad attachment, a
   * conversation that is no longer available. Carries the server's own wording
   * so the customer is told what happened instead of waiting out a timeout.
   */
  onServerError?: (e: { code: string; message: string }) => void;
  /** Live agent-presence updates from the gateway. */
  onAgentsPresence?: (count: number) => void;
  /** Fires when the agent marks the conversation closed/resolved. Triggers CSAT. */
  onClosed?: (info: { conversationId: string; status: 'closed' | 'resolved' }) => void;
  /**
   * The conversation now exists.
   *
   * Emitted when the customer's first message creates it. Until then the
   * widget has no conversation id, because opening the widget no longer
   * creates one — that is what produced duplicate empty threads for a visitor
   * who scanned a QR code twice.
   */
  onConversationReady?: (info: { conversationId: string }) => void;
}

export interface ConnectOptions {
  /**
   * The conversation this device opened earlier (see resume.ts). The gateway
   * honours it only for an unverified walk-in, and only after confirming the
   * thread is this contact's; a gateway that predates it ignores it.
   */
  resumeConversationId?: string;
  /**
   * Can this page mint itself a fresh token by reloading?
   *
   * True for the Yiji app, whose host page carries a session token and issues
   * a new one on every load. FALSE for a QR walk-in: its token came from a
   * phone number typed once into `/walk-in`, lives in this tab's
   * `sessionStorage`, and there is nothing to re-mint it from — so a reload
   * finds an expired token, clears it, and bounces the customer back to the
   * phone form, losing the conversation they were in the middle of.
   *
   * Defaults to false: reloading the page out from under a customer is the
   * exceptional act, and it should have to be asked for.
   */
  canRemintToken?: boolean;
}

export function connectWidget(
  url: string,
  token: string,
  cb: SocketCallbacks,
  options: ConnectOptions = {},
): Socket {
  const socket = io(url, {
    // Tells the gateway this bundle creates conversations on first message,
    // so it must NOT create one at handshake. A gateway that predates the flag
    // ignores it; a widget that predates it gets the old eager path.
    auth: {
      kind: 'customer',
      token,
      lazyConversation: true,
      ...(options.resumeConversationId
        ? { resumeConversationId: options.resumeConversationId }
        : {}),
    },
    /**
     * POLLING FIRST, then upgrade. Not websocket-first.
     *
     * `['websocket', 'polling']` looks like it has a fallback and does not
     * really have one: socket.io tries the first transport, and where the
     * WebSocket constructor is absent or the upgrade is blocked outright it
     * can fail without ever reaching the second. Reproduced by deleting
     * `window.WebSocket`: ZERO socket.io requests were made and the panel sat
     * on "Connecting…" for ever — no send, no online state, no offline
     * details, because none of that code runs until the socket is up.
     *
     * That is the customer's view from inside the Yiji app's webview, which is
     * exactly where this was reported (2026-09-09). A desktop browser never
     * showed it, because the upgrade always succeeded there.
     *
     * Polling always works: it is ordinary HTTP through the same CloudFront
     * path. socket.io then upgrades to WebSocket in the background when it
     * can, so a healthy network still ends up on a socket — it just is not
     * the thing standing between the customer and their first message.
     */
    transports: ['polling', 'websocket'],
    // Harmless off-ngrok; lets the polling handshake skip ngrok-free's browser
    // interstitial when the widget is served through an ngrok tunnel.
    extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
  });

  const startedAt = Date.now();
  /*
   * HAS THIS SESSION EVER BEEN UP?
   *
   * The difference between "we cannot start this chat" and "we lost the chat
   * and are getting it back" — and the widget had no way to tell them apart.
   * A refusal at startup is terminal and worth saying out loud; a drop after a
   * working connection is ordinary and recovers on its own.
   */
  let everConnected = false;
  cb.onStatus('connecting');
  socket.on('connect', () => {
    everConnected = true;
    cb.onStatus('connected');
  });
  socket.io.on('reconnect_attempt', () => cb.onStatus('reconnecting'));
  /*
   * A DROP IS NOT A FAILURE, AND SOMETHING MUST SAY SO.
   *
   * There was no `disconnect` handler at all, so the only states reachable
   * after a working connection were 'reconnecting' and the terminal 'error'.
   * Socket.IO reconnects on its own (attempts are unlimited here), so this
   * reports the truth — we are coming back — rather than leaving the last
   * status standing.
   */
  socket.on('disconnect', () => {
    if (everConnected) cb.onStatus('reconnecting');
  });
  socket.on('connect_error', (err: Error) => {
    /*
     * ONLY an error if we are not actually connected.
     *
     * `connect_error` fires for a failed TRANSPORT attempt, not only for a
     * failed session. The widget asks for `['polling', 'websocket']`, and the
     * WebSocket upgrade FAILS over CloudFront — it serves HTTP/2, which has no
     * Upgrade header, so the attempt 400s. That is harmless: polling is already
     * connected and carrying traffic.
     *
     * Setting 'error' unconditionally made that harmless failure permanent. The
     * banner said "cannot connect" over a live socket, `canSend` went false so
     * the composer locked, and the offline block pinned itself open through
     * `status === 'error'` — so an agent coming online changed nothing on
     * screen even though the `agents:presence` pulse was arriving. Reported
     * from production: "the agent is online but it still shows offline".
     *
     * `socket.connected` distinguishes the two: a genuine refusal (bad token,
     * gateway down) leaves it false and still reports the error.
     */
    if (socket.connected) return;
    /*
     * A FAILED RETRY ON A SESSION THAT ONCE WORKED IS NOT TERMINAL.
     *
     * `socket.connected` alone was not enough. It answers "are we up right
     * now", and during a reconnect the answer is legitimately no — so the
     * FIRST retry to fail for any transient reason (a 502 while ECS swaps a
     * task, the sticky instance being replaced, a phone moving from the
     * branch wifi to cellular) set 'error'.
     *
     * Nothing ever set it back. 'error' was a one-way door: no handler
     * downgrades it, so `canSend` stayed false and the composer stayed
     * locked while socket.io went on retrying invisibly in the background.
     * The customer saw "Reconnecting…" become "We could not start this
     * chat" on a chat that had been working a second earlier, and no amount
     * of waiting fixed it (owner, 2026-09-16, screenshots — a QR walk-in
     * being told to reopen from an app they never used).
     *
     * `everConnected` is the missing distinction: this session HAS been up,
     * so the session itself is fine and the retries are the right answer.
     */
    if (everConnected) {
      cb.onStatus('reconnecting');
      return;
    }
    cb.onStatus('error');
    // The customer token is minted once by the host page and can't be refreshed
    // in-place (the widget has no signing secret). When it expires mid-session
    // the gateway rejects every reconnect with an auth error, so the widget would
    // sit at "connecting" forever. Reload to re-mint a fresh token. The grace
    // window distinguishes a genuine mid-session expiry (reload, self-heals) from
    // a token that's bad at startup, e.g. a secret mismatch (don't reload-loop).
    const authError = /token|jwt|unauthorized|inactive vendor/i.test(err.message);
    /*
     * ONLY RELOAD WHERE A RELOAD CAN HELP.
     *
     * This self-heals an expired token by re-minting it — which the Yiji app's
     * host page does on load. A QR walk-in has no such source: reloading makes
     * `takeWalkInSession` find the expired token, clear it, and redirect to
     * the phone form, so the customer loses the thread they were typing in and
     * is asked for their number again. For them a refusal must be reported,
     * not "fixed" by throwing the page away.
     */
    if (
      authError &&
      options.canRemintToken === true &&
      Date.now() - startedAt > 30_000 &&
      typeof window !== 'undefined'
    ) {
      window.location.reload();
    }
  });
  socket.on(
    'ready',
    (info: {
      conversationId: string | null;
      branding: unknown;
      agentsOnline?: number;
      vendorName?: string | null;
      contact?: { name: string | null; phone: string | null };
      isNew?: boolean;
    }) => cb.onReady({ ...info, agentsOnline: info.agentsOnline ?? 0 }),
  );
  socket.on('conversation:ready', (info: { conversationId: string }) =>
    cb.onConversationReady?.(info),
  );
  // The customer's most recent order, for the WhatsApp prefill. Arrives after
  // `ready` (the upstream call is slow) and may never arrive at all.
  socket.on('customer:latest-order', (info: { orderId?: string }) => {
    if (info?.orderId) cb.onLatestOrder?.(info.orderId);
  });
  /*
   * THE GATEWAY'S REFUSALS, WHICH NOBODY WAS LISTENING TO.
   *
   * It emits twelve distinct `error` responses — rate_limited, bad_payload,
   * attachment_rejected, conversation_unavailable, forbidden, persist_failed —
   * each with a message written for a human. The widget registered no handler
   * for any of them, so an INSTANT refusal was indistinguishable from a slow
   * network: the bubble sat "sending" for the full 15-second timeout and then
   * went red with no reason given.
   *
   * The worst of those is `rate_limited`, where the customer's natural response
   * — send it again — is the one thing guaranteed to fail again.
   */
  socket.on('error', (e: { code?: string; message?: string }) => {
    cb.onServerError?.({ code: e?.code ?? 'unknown', message: e?.message ?? '' });
  });
  socket.on('message:new', (msg: WidgetMessage) => cb.onMessage(msg));
  socket.on(
    'messages:history',
    (info: {
      conversationId: string;
      messages: Array<{
        id: string;
        senderType: WidgetMessage['senderType'];
        content: string;
        createdAt: string;
        attachments?: string[];
      }>;
    }) =>
      cb.onHistory?.(
        info.messages.map((m) => ({
          id: m.id,
          conversationId: info.conversationId,
          senderType: m.senderType,
          content: m.content,
          attachments: m.attachments ?? [],
          createdAt: m.createdAt,
        })),
      ),
  );
  socket.on('typing:update', (e: { isTyping: boolean; who: string }) => {
    if (e.who === 'agent') cb.onTyping(e.isTyping);
  });
  socket.on('agents:presence', (e: { count: number }) => cb.onAgentsPresence?.(e.count));
  socket.on(
    'conversation:closed',
    (e: { conversationId: string; status: 'closed' | 'resolved' }) => {
      cb.onClosed?.(e);
    },
  );
  return socket;
}
