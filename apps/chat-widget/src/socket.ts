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
}

export interface SocketCallbacks {
  onReady: (info: {
    conversationId: string;
    branding: unknown;
    agentsOnline: number;
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
  /** Live agent-presence updates from the gateway. */
  onAgentsPresence?: (count: number) => void;
  /** Fires when the agent marks the conversation closed/resolved. Triggers CSAT. */
  onClosed?: (info: { conversationId: string; status: 'closed' | 'resolved' }) => void;
}

export function connectWidget(url: string, token: string, cb: SocketCallbacks): Socket {
  const socket = io(url, {
    auth: { kind: 'customer', token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
  });

  const startedAt = Date.now();
  cb.onStatus('connecting');
  socket.on('connect', () => cb.onStatus('connected'));
  socket.io.on('reconnect_attempt', () => cb.onStatus('reconnecting'));
  socket.on('connect_error', (err: Error) => {
    cb.onStatus('error');
    // The customer token is minted once by the host page and can't be refreshed
    // in-place (the widget has no signing secret). When it expires mid-session
    // the gateway rejects every reconnect with an auth error, so the widget would
    // sit at "connecting" forever. Reload to re-mint a fresh token. The grace
    // window distinguishes a genuine mid-session expiry (reload, self-heals) from
    // a token that's bad at startup, e.g. a secret mismatch (don't reload-loop).
    const authError = /token|jwt|unauthorized|inactive vendor/i.test(err.message);
    if (authError && Date.now() - startedAt > 30_000 && typeof window !== 'undefined') {
      window.location.reload();
    }
  });
  socket.on(
    'ready',
    (info: {
      conversationId: string;
      branding: unknown;
      agentsOnline?: number;
      contact?: { name: string | null; phone: string | null };
      isNew?: boolean;
    }) => cb.onReady({ ...info, agentsOnline: info.agentsOnline ?? 0 }),
  );
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
