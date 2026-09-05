import type { Server, Socket } from 'socket.io';
import type { Logger } from 'pino';
import {
  SOCKET_EVENTS,
  rooms,
  MessageSend,
  NoteAdd,
  NoteDelete,
  TypingSignal,
  ReadAck,
  CsatSubmit,
  type MessageNew,
} from '@yiji/shared-types';
import type { GatewayDirectus } from './directus.js';
import type { CustomerVerifier } from './auth/customer-jwt.js';
import { CustomerTokenError } from './auth/customer-jwt.js';
import { validateAgentToken } from './auth/agent-jwt.js';
import type { SideEffectProducer } from './queue.js';
import { createAgentPresence } from './agent-presence.js';
import {
  validateAttachments,
  sanitizeFilename,
  decodeUploadContent,
  type AttachmentPolicy,
} from './attachments.js';
import { createTokenBucket } from './rate-limit.js';

interface SocketData {
  kind: 'customer' | 'agent';
  vendorId?: string; // CRM vendor UUID
  vendorColors?: unknown;
  vendorName?: string | null;
  contactId?: string;
  contactName?: string | null;
  contactPhone?: string | null;
  contactIsNew?: boolean;
  /**
   * The Yiji customer id we hold for this contact, or null if unknown there.
   *
   * Drives whether a walk-in resumes an existing thread: a KNOWN customer is
   * no longer a guess, so a later walk-in by the same number is the same
   * person continuing the same conversation.
   */
  contactExternalId?: string | null;
  /**
   * Set once the conversation EXISTS. Undefined until the customer actually
   * sends something — see `ensureConversation`.
   */
  conversationId?: string;
  conversationCreated?: boolean;
  /** Session came from the store QR code; the phone was typed, not proven. */
  walkIn?: boolean;
  agentId?: string;
  /**
   * Serialises conversation creation for THIS socket.
   *
   * Two messages sent in the same instant both find no conversation and both
   * create one. Holding the in-flight promise means the second awaits the
   * first instead of racing it.
   */
  conversationPromise?: Promise<string>;
}

export interface ConnectionDeps {
  io: Server;
  directus: GatewayDirectus;
  directusUrl: string;
  verifier: CustomerVerifier;
  producer: SideEffectProducer;
  logger: Logger;
  // Optional with safe defaults so callers/tests that don't supply them still
  // work; index.ts always passes them from config.
  attachmentPolicy?: AttachmentPolicy;
  rateLimit?: { capacity: number; refillPerSec: number };
  /**
   * Cross-instance presence, used by auto-assignment. Optional: without Redis
   * there is no shared presence and no routing, and the gateway still works as a
   * single in-memory instance.
   */
  presenceStore?: {
    online(userId: string): Promise<void>;
    offline(userId: string): Promise<void>;
    touch(userId: string): Promise<void>;
  };
}

const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = {
  maxBytes: 10 * 1024 * 1024,
  allowedMime: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
  ],
};
const DEFAULT_RATE_LIMIT = { capacity: 20, refillPerSec: 5 };

/** Extract a human message from an Error or a Directus SDK error object. */
function extractAuthError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'errors' in err) {
    const errors = (err as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors) && errors[0]?.message) return `directus: ${errors[0].message}`;
  }
  return 'unauthorized';
}

/** In-memory presence per vendor room (per gateway instance). */
const presence = new Map<string, Set<string>>();
function addPresence(vendorId: string, id: string): string[] {
  const set = presence.get(vendorId) ?? new Set<string>();
  set.add(id);
  presence.set(vendorId, set);
  return [...set];
}
function removePresence(vendorId: string, id: string): string[] {
  const set = presence.get(vendorId);
  if (set) set.delete(id);
  return set ? [...set] : [];
}

/**
 * Singleton agent-presence tracker. Module-level so all handlers share state.
 * The full state machine + invariants are documented in ./agent-presence.ts.
 */
const agentPresence = createAgentPresence();

function broadcastAgentPresence(io: import('socket.io').Server): void {
  io.emit(SOCKET_EVENTS.agentsPresence, { count: agentPresence.distinctOnline() });
}

/** Diagnostic snapshot — wired to GET /debug/presence in index.ts. */
export function getAgentPresenceSnapshot() {
  return agentPresence.snapshot();
}

export function registerConnection(deps: ConnectionDeps): void {
  const { io, directus, directusUrl, verifier, logger } = deps;

  // --- Auth middleware: validate token, onboard, attach socket.data ---
  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as {
      kind?: string;
      token?: string;
      /**
       * Set by a widget that knows conversations are created on first message
       * (see ensureConversation). A widget WITHOUT it is an older bundle whose
       * send() refuses to fire until it holds a conversation id — so for that
       * client the conversation is still created here at handshake, exactly as
       * before, or a fresh visitor could never send anything.
       *
       * The widget bundle is not part of the ECS deploy: it is served from a
       * host of its own (locally, or a CDN in production) and updates on its
       * own schedule. The gateway therefore cannot assume the two roll out
       * together, and this flag is how it tells which widget it is talking to.
       */
      lazyConversation?: boolean;
    };
    const data = socket.data as SocketData;
    try {
      if (auth.kind === 'agent') {
        if (!auth.token) throw new Error('missing token');
        const agent = await validateAgentToken(directusUrl, auth.token);
        if (!agent) throw new Error('invalid agent token');
        data.kind = 'agent';
        data.agentId = agent.id;
        return next();
      }
      // Default: customer (widget)
      if (!auth.token) throw new CustomerTokenError('missing token');
      const claims = verifier.verify(auth.token);
      const vendor = await directus.resolveVendor(claims.vendor_id);
      if (!vendor) throw new CustomerTokenError('unknown or inactive vendor');
      const contact = await directus.upsertContact(vendor.id, claims);
      data.kind = 'customer';
      data.vendorId = vendor.id;
      data.vendorColors = vendor.colors;
      data.vendorName = vendor.name;
      data.contactId = contact.id;
      data.contactName = contact.name;
      data.contactPhone = contact.phone;
      data.contactIsNew = contact.isNew;
      data.contactExternalId = contact.externalCustomerId;
      if (contact.promoted) {
        // Worth a line in the log: this is the moment an anonymous walk-in
        // became a named customer, and it is otherwise invisible.
        logger.info(
          { contactId: contact.id, externalCustomerId: contact.externalCustomerId },
          'walk-in contact promoted to a registered Yiji customer',
        );
      }
      data.walkIn = claims.walk_in === true;

      /*
       * NO conversation is created here.
       *
       * This used to create one during the handshake, so merely OPENING the
       * widget wrote a row — whether or not the visitor ever typed anything.
       * For a walk-in that is doubly bad, because `createWalkInConversation`
       * always creates rather than reusing: one customer scanning a QR code
       * twice, or reloading the page, produced two threads bearing the same
       * phone number and no messages. The agent inbox then shows the same
       * person twice, one of them empty, and there is no way to tell which is
       * the real conversation.
       *
       * A conversation now begins when the customer says something. See
       * `ensureConversation`. A returning, non-walk-in customer still resumes
       * their existing thread, so their history is attached to the first
       * message — resolved BELOW for the seed, without creating anything.
       */
      if (auth.lazyConversation === true) {
        // New widget: resume an existing thread for the seed, create nothing.
        if (!data.walkIn) {
          const existing = await directus.findLiveConversation(vendor.id, contact.id);
          if (existing) {
            data.conversationId = existing;
            data.conversationCreated = false;
          }
        }
      } else {
        // Old widget: it cannot send without an id, so give it one now. This
        // keeps a stale bundle working; it also keeps the duplicate-thread
        // behaviour for walk-ins on that bundle, which is why updating the
        // widget host is part of finishing this fix, not optional.
        const conv = data.walkIn
          ? await directus.createWalkInConversation(
              vendor.id,
              contact.id,
              claims.phone ?? '',
              !!contact.externalCustomerId,
            )
          : await directus.findOrCreateConversation(vendor.id, contact.id);
        data.conversationId = conv.id;
        data.conversationCreated = conv.created;
      }
      return next();
    } catch (err) {
      // Surface the REAL cause. Directus SDK rejects with a non-Error object
      // ({ errors: [{ message }] }), which the old `instanceof Error` check
      // swallowed into a useless "unauthorized" — hiding e.g. a failing vendor
      // lookup (bad svc token / Directus unreachable) behind a generic message.
      const msg = extractAuthError(err);
      logger.warn({ kind: auth.kind, err: msg }, 'connection rejected');
      return next(new Error(msg));
    }
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    if (data.kind === 'customer') void onCustomerConnect(socket, deps);
    else if (data.agentId) {
      void onAgentConnect(socket, deps);
      // agentPresence.add returns true only for a brand-new agent (not a
      // tab dup or a reconnect inside the grace window) — that's the only
      // case we need to broadcast for.
      if (agentPresence.add(socket.id, data.agentId)) broadcastAgentPresence(io);
      // Publish to the shared registry so the workers service can route to this
      // agent. Fire-and-forget: presence is a routing hint, and failing to
      // record it must never stop an agent connecting.
      void deps.presenceStore?.online(data.agentId).catch(() => undefined);
    }

    registerHandlers(socket, deps);

    socket.on('disconnect', () => {
      if (data.kind === 'customer' && data.vendorId) {
        const online = removePresence(data.vendorId, socket.id);
        io.to(rooms.vendor(data.vendorId)).emit(SOCKET_EVENTS.presenceUpdate, {
          vendorId: data.vendorId,
          online,
        });
      } else if (data.kind === 'agent') {
        // Transport-level disconnect: schedule a grace timer. If a reload
        // reconnects within OFFLINE_GRACE_MS, the timer is cancelled and we
        // never broadcast offline → no flicker.
        const leavingAgentId = data.agentId;
        agentPresence.remove(socket.id, false, () => {
          broadcastAgentPresence(io);
          if (leavingAgentId) {
            void deps.presenceStore?.offline(leavingAgentId).catch(() => undefined);
          }
        });
      }
    });
  });
  logger.info('connection handlers registered');
}

/**
 * The conversation for this customer socket, created on FIRST USE.
 *
 * Creating it at handshake meant opening the widget was enough to produce a
 * row. A walk-in visitor who scanned the QR code twice — or simply reloaded —
 * got two threads under one phone number, one of them holding nothing but its
 * own system note, and the agent inbox showed the customer twice with no way
 * to tell which thread was real.
 *
 * Called from the first write a customer makes, so an empty conversation is
 * never persisted at all. Idempotent per socket: the in-flight promise is
 * cached, so two messages sent in the same tick share one creation instead of
 * racing to make two.
 */
async function ensureConversation(socket: Socket, deps: ConnectionDeps): Promise<string> {
  const data = socket.data as SocketData;
  if (data.conversationId) return data.conversationId;
  if (data.conversationPromise) return data.conversationPromise;
  if (!data.vendorId || !data.contactId) throw new Error('socket is not onboarded');

  const { directus, io, producer, logger } = deps;
  const vendorId = data.vendorId;
  const contactId = data.contactId;

  data.conversationPromise = (async () => {
    // A walk-in gets its OWN thread rather than reusing one: the phone was
    // typed by somebody standing in a store, not proven, so it must not open a
    // thread that number already owns.
    const conv = data.walkIn
      ? await directus.createWalkInConversation(
          vendorId,
          contactId,
          data.contactPhone ?? '',
          !!data.contactExternalId,
        )
      : await directus.findOrCreateConversation(vendorId, contactId);

    data.conversationId = conv.id;
    data.conversationCreated = conv.created;
    await socket.join(rooms.conversation(conv.id));
    // The widget learns its id here rather than at handshake, because until
    // now there was nothing to name.
    socket.emit('conversation:ready', { conversationId: conv.id });

    if (conv.created) {
      // Fires the conversation_created automation trigger (assignment /
      // keyword rules) exactly once, now that the conversation is real.
      await producer
        .conversationCreated(conv.id)
        .catch((err) => logger.warn({ err }, 'conversationCreated enqueue failed'));
      // Agents' inboxes only learn about a conversation once it exists.
      io.to(rooms.agentsAll()).emit(SOCKET_EVENTS.inboxActivity, { conversationId: conv.id });
    }
    return conv.id;
  })();

  try {
    return await data.conversationPromise;
  } catch (err) {
    // Clear the cache so a transient failure does not wedge the socket into
    // never being able to open a conversation again.
    data.conversationPromise = undefined;
    throw err;
  }
}

async function onCustomerConnect(socket: Socket, deps: ConnectionDeps): Promise<void> {
  const { io, directus, logger } = deps;
  const data = socket.data as SocketData;
  // No conversation is required to connect any more — one is created on the
  // customer's first message (see ensureConversation). A returning customer
  // already has theirs resolved at handshake, so join it for live delivery.
  if (!data.vendorId) return;
  if (data.conversationId) await socket.join(rooms.conversation(data.conversationId));
  await socket.join(rooms.vendor(data.vendorId));
  const online = addPresence(data.vendorId, socket.id);
  io.to(rooms.vendor(data.vendorId)).emit(SOCKET_EVENTS.presenceUpdate, {
    vendorId: data.vendorId,
    online,
  });
  // Tell the widget which conversation it is attached to + vendor branding,
  // the current agent-online count (so it can render the offline fallback on
  // connect without waiting for the next agents:presence pulse), and the
  // contact identity so a returning, named customer is greeted by name.
  socket.emit('ready', {
    // null until the customer sends something. The widget receives the real id
    // on `conversation:ready`, emitted the moment the conversation is created.
    conversationId: data.conversationId ?? null,
    branding: data.vendorColors ?? null,
    // The vendor the customer is actually talking to — the widget's
    // "Powered by" line names them, not the CRM.
    vendorName: data.vendorName ?? null,
    agentsOnline: agentPresence.distinctOnline(),
    contact: { name: data.contactName ?? null, phone: data.contactPhone ?? null },
    isNew: data.contactIsNew ?? true,
  });
  // Seed the existing thread so a returning customer (or a reconnect) sees their
  // history instead of a blank panel. Best-effort: a failure just means no seed.
  // CUSTOMER-side view is capped to the last 7 days by request: a months-long
  // relationship stays in the system and fully visible to agents, but the
  // widget only replays the recent week.
  //
  // A WALK-IN session replays nothing, and the conversation it was just given
  // is empty anyway — this is belt and braces. The phone was typed by somebody
  // in a store, not proven, so history is not theirs to be shown even if a
  // future change made this conversation resumable.
  /*
   * History replay: withheld from an UNVERIFIED walk-in, allowed once known.
   *
   * The rule was "never for a walk-in", because a typed phone is not proof and
   * replaying a stranger's chat to whoever guessed a number is the worst case.
   * That still holds for an unknown contact. But a contact we have identified
   * through the Yiji app is not a guess any more, and withholding their own
   * history from them is just a worse product.
   */
  if ((!data.walkIn || data.contactExternalId) && data.conversationId) {
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const history = await directus.loadConversationMessages(data.conversationId, { since });
      if (history.length > 0) {
        socket.emit('messages:history', { conversationId: data.conversationId, messages: history });
      }
    } catch (err) {
      logger.warn({ err }, 'failed to load conversation history');
    }
  }
  // A conversation created at HANDSHAKE (old-widget path) fires its automation
  // trigger here; one created lazily fires it inside ensureConversation. Both
  // paths fire it exactly once, at the moment the conversation comes to exist.
  if (data.conversationCreated && data.conversationId) {
    await deps.producer
      .conversationCreated(data.conversationId)
      .catch((err) => logger.warn({ err }, 'conversationCreated enqueue failed'));
  }
}

async function onAgentConnect(socket: Socket, { directus }: ConnectionDeps): Promise<void> {
  const data = socket.data as SocketData;
  if (!data.agentId) return;
  await socket.join(rooms.agent(data.agentId));
  await socket.join(rooms.agentsAll());
  const ids = await directus.listAgentConversationIds(data.agentId);
  for (const id of ids) await socket.join(rooms.conversation(id));
}

function registerHandlers(socket: Socket, deps: ConnectionDeps): void {
  const { io, directus, producer, logger } = deps;
  const attachmentPolicy = deps.attachmentPolicy ?? DEFAULT_ATTACHMENT_POLICY;
  const rateLimit = deps.rateLimit ?? DEFAULT_RATE_LIMIT;
  const data = socket.data as SocketData;
  // One token bucket per socket — throttles inbound write events (message:send,
  // note:add) to a burst + sustained rate.
  const writeBucket = createTokenBucket(rateLimit.capacity, rateLimit.refillPerSec);

  // Explicit logout signal from an agent. We mirror the disconnect cleanup
  // up-front so the host-page "agents online" pill flips immediately —
  // before the transport close even reaches us (which on some networks is
  // delayed by tens of seconds, especially if the browser is in the middle
  // of navigating away from the route). Then we close the socket ourselves
  // so further events from this socket are dropped.
  socket.on(SOCKET_EVENTS.agentLogout, () => {
    if (data.kind !== 'agent' || !data.agentId) return;
    const userId = data.agentId;
    // Disconnect every socket we hold for this user, not just the one
    // that emitted the event. Reasoning: development HMR (and an
    // occasional flaky network) can leave orphan sockets registered to
    // the same agentId — the agent's most recent tab logs out, but
    // refCount stays > 0 because an orphan still holds a slot, so the
    // customer page would keep showing "online" until the orphan times
    // out via Engine.IO ping (~25–45s). Production note: signing out of
    // one device also ends sessions for that same agent's other devices.
    // That's intentional — a logout is "this agent is leaving" rather
    // than "this tab is leaving" — but if you ever want per-device
    // logout you'd narrow this loop to `[socket.id]`.
    const sidsForUser = agentPresence.socketsForUser(userId);
    logger.info(
      { userId, sockets: sidsForUser.length },
      'agent:logout — closing all sockets for user',
    );
    let presenceWasDropped = false;
    for (const sid of sidsForUser) {
      if (agentPresence.remove(sid, true, () => undefined)) presenceWasDropped = true;
      io.sockets.sockets.get(sid)?.disconnect(true);
    }
    if (presenceWasDropped) broadcastAgentPresence(io);
  });

  socket.on(SOCKET_EVENTS.messageSend, async (raw: unknown) => {
    if (!writeBucket.tryRemove())
      return socket.emit(SOCKET_EVENTS.error, {
        code: 'rate_limited',
        message: 'too many messages, slow down',
      });
    const parsed = MessageSend.safeParse(raw);
    if (!parsed.success)
      return socket.emit(SOCKET_EVENTS.error, { code: 'bad_payload', message: 'invalid message' });
    const { conversationId: requestedId, content, attachments, clientMsgId } = parsed.data;
    let conversationId = requestedId;

    if (data.kind === 'customer') {
      /*
       * A customer's FIRST message is what brings the conversation into
       * existence, so at this point there may be nothing to compare against.
       * The widget sends whatever id it was given — null on a fresh session —
       * and the server decides. That keeps the IDOR guard below meaningful
       * while allowing the id to be unknown to the client.
       */
      try {
        conversationId = await ensureConversation(socket, deps);
      } catch (err) {
        logger.error({ err }, 'could not open a conversation');
        return socket.emit(SOCKET_EVENTS.error, {
          code: 'conversation_unavailable',
          message: 'could not open a conversation',
        });
      }
      // IDOR guard: a customer socket is bound to exactly ONE conversation.
      // Never let a client-supplied id target another customer's conversation —
      // that would be cross-tenant message injection. A client that names a
      // DIFFERENT conversation than the one it owns is refused; one that names
      // none (a fresh session) simply gets its own.
      if (requestedId && requestedId !== conversationId) {
        return socket.emit(SOCKET_EVENTS.error, {
          code: 'forbidden',
          message: 'conversation not accessible',
        });
      }
    }

    // An AGENT always names the conversation: they act on the shared inbox and
    // nothing else can resolve which thread they mean. Only a customer's first
    // message is allowed to arrive without one.
    if (!conversationId) {
      return socket.emit(SOCKET_EVENTS.error, {
        code: 'bad_payload',
        message: 'conversationId is required',
      });
    }
    const convId: string = conversationId;
    try {
      // Attachment validation (MIME allow-list + size cap) before persisting.
      if (attachments && attachments.length > 0) {
        const metas = await directus.getFilesMeta(attachments);
        const check = validateAttachments(attachments, metas, attachmentPolicy);
        if (!check.ok) {
          logger.warn({ conversationId, reason: check.reason }, 'attachment rejected');
          return socket.emit(SOCKET_EVENTS.error, {
            code: 'attachment_rejected',
            message: check.reason ?? 'attachment not allowed',
          });
        }
      }
      const senderType = data.kind === 'agent' ? 'agent' : 'customer';
      const saved = await directus.persistMessage({
        conversationId: convId,
        senderType,
        senderUser: data.kind === 'agent' ? data.agentId : undefined,
        senderContact: data.kind === 'customer' ? data.contactId : undefined,
        content,
        attachments,
      });
      const payload: MessageNew = {
        id: saved.id,
        conversationId: convId,
        senderType,
        content,
        attachments: attachments ?? [],
        createdAt: saved.createdAt,
        clientMsgId,
      };
      io.to(rooms.conversation(convId)).emit(SOCKET_EVENTS.messageNew, payload);
      // Signal every agent inbox to refresh (covers conversations they haven't joined).
      io.to(rooms.agentsAll()).emit(SOCKET_EVENTS.inboxActivity, { conversationId: convId });
      // Carry the message text so keyword-based automation rules can match.
      await producer.messageReceived(convId, content);

      // Auto-assignment: only a CUSTOMER message starts the ladder. An agent
      // typing is the opposite signal — the conversation is already being
      // handled. The stage-0 job is idempotent per conversation, so a customer
      // sending three messages in a row starts one ladder, not three racing
      // ones; and the worker stands down if someone already owns it.
      if (senderType === 'customer') {
        void producer
          .enqueueRouting({
            conversationId: convId,
            stage: 'assign',
            attemptedAgentIds: [],
            outboundCountAtSchedule: 0,
          })
          .catch((err: unknown) => logger.warn({ err }, 'auto-assign enqueue failed'));
      }
      // Agent activity pushes them to the back of the idle queue, so the next
      // conversation goes to whoever has been waiting longest.
      if (senderType === 'agent' && data.agentId) {
        void deps.presenceStore?.touch(data.agentId).catch(() => undefined);
      }

      /*
       * An agent replied — does the customer have any way of knowing?
       *
       * The widget already promises "we will get back to you" when nobody is
       * online. The other half of that promise is this: the reply lands hours
       * later in a chat the customer closed, and only their phone can tell
       * them. Enqueued for the mobile app to deliver.
       *
       * ONLY when no customer socket is in the conversation. Somebody watching
       * the thread is already reading the message; notifying them as well is
       * how a chat app becomes something people mute. `fetchSockets` is
       * adapter-aware, so this stays correct across multiple gateway instances
       * rather than only seeing the sockets on this one.
       */
      if (senderType === 'agent') {
        void (async () => {
          try {
            const inRoom = await io.in(rooms.conversation(convId)).fetchSockets();
            const customerWatching = inRoom.some(
              (sock) => (sock.data as SocketData).kind === 'customer',
            );
            if (customerWatching) return;
            const contact = await directus.loadConversationContact(convId);
            await producer.enqueueCustomerPush({
              conversationId: convId,
              phone: contact?.phone ?? null,
              externalCustomerId: contact?.externalCustomerId ?? null,
              // One line, not the thread — see CustomerPushJob.
              preview: content.replace(/\s+/g, ' ').trim().slice(0, 140),
              sentAt: saved.createdAt,
            });
          } catch (err) {
            // A missed notification must never fail the send. The message is
            // already persisted and delivered to every agent surface.
            logger.warn({ err, conversationId }, 'customer push enqueue failed');
          }
        })();
      }
    } catch (err) {
      logger.error({ err }, 'message:send failed');
      socket.emit(SOCKET_EVENTS.error, {
        code: 'persist_failed',
        message: 'could not send message',
      });
    }
  });

  // Attachment upload (esp. the customer widget, which has no Directus account):
  // the client sends bytes, the gateway validates MIME/size, uploads via the
  // service token, and acks the Directus file id to reference in message:send.
  //   emit('attachment:upload', { filename, mimetype, content }, (res) => ...)
  //   content: ArrayBuffer | typed array | base64 string
  //   ack res: { ok:true, id, type, filesize } | { ok:false, error }
  socket.on('attachment:upload', async (raw: unknown, ack?: (res: unknown) => void) => {
    const respond = typeof ack === 'function' ? ack : () => undefined;
    if (!writeBucket.tryRemove()) return respond({ ok: false, error: 'rate_limited' });
    const data = raw as { filename?: unknown; mimetype?: unknown; content?: unknown };
    const filename = sanitizeFilename(data?.filename);
    const mimetype = typeof data?.mimetype === 'string' ? data.mimetype.toLowerCase() : '';
    const buf = decodeUploadContent(data?.content);
    if (!buf) return respond({ ok: false, error: 'no file content' });
    if (!attachmentPolicy.allowedMime.includes(mimetype))
      return respond({ ok: false, error: `type "${mimetype || 'unknown'}" not allowed` });
    if (buf.length > attachmentPolicy.maxBytes)
      return respond({ ok: false, error: 'file too large' });
    try {
      const file = await directus.uploadFile(buf, filename, mimetype);
      respond({ ok: true, id: file.id, type: file.type, filesize: file.filesize });
    } catch (err) {
      logger.error({ err }, 'attachment upload failed');
      respond({ ok: false, error: 'upload failed' });
    }
  });

  // Fetch a received attachment's bytes for the customer widget (which has no
  // Directus session of its own). Authorized: the file must belong to a message
  // in THIS socket's conversation, so a crafted id can't read another
  // conversation's files. Agents fetch attachments directly via their own
  // Directus token, so this path is customer-only.
  //   emit('attachment:get', { id }, (err, res) => ...)
  //   ack res: { ok:true, content: base64, type, filename } | { ok:false, error }
  socket.on('attachment:get', async (raw: unknown, ack?: (res: unknown) => void) => {
    const respond = typeof ack === 'function' ? ack : () => undefined;
    if (data.kind !== 'customer' || !data.conversationId)
      return respond({ ok: false, error: 'unauthorized' });
    const fileId = (raw as { id?: unknown })?.id;
    if (typeof fileId !== 'string' || !fileId) return respond({ ok: false, error: 'bad request' });
    try {
      const file = await directus.getConversationAttachment(data.conversationId, fileId);
      if (!file) return respond({ ok: false, error: 'not found' });
      respond({ ok: true, content: file.content, type: file.type, filename: file.filename });
    } catch (err) {
      logger.error({ err }, 'attachment:get failed');
      respond({ ok: false, error: 'fetch failed' });
    }
  });

  // Delete an internal note: agents only. The directus helper re-checks the
  // message is in this conversation AND is actually an internal note, so a
  // crafted payload can't wipe a real customer message. On failure we send
  // an error back to the requesting socket so the client can roll its
  // optimistic UI back immediately instead of waiting for the refetch
  // failsafe.
  socket.on(SOCKET_EVENTS.noteDelete, async (raw: unknown) => {
    if (data.kind !== 'agent') return;
    const parsed = NoteDelete.safeParse(raw);
    if (!parsed.success) {
      socket.emit(SOCKET_EVENTS.error, {
        code: 'bad_payload',
        message: 'invalid note:delete',
      });
      return;
    }
    const { conversationId, noteId } = parsed.data;
    try {
      const ok = await directus.deleteInternalNote(conversationId, noteId);
      if (!ok) {
        // Not an internal note, or already gone. Tell the caller so they
        // can refetch and resync.
        socket.emit(SOCKET_EVENTS.error, {
          code: 'note_delete_rejected',
          message: 'note not found or not an internal note',
        });
        return;
      }
      io.to(rooms.conversation(conversationId)).emit(SOCKET_EVENTS.noteDeleted, {
        conversationId: conversationId,
        noteId,
      });
    } catch (err) {
      logger.error({ err }, 'note:delete failed');
      // The most common cause locally is svc-socket-gateway missing the
      // `messages.delete` permission until the bootstrap is re-run. Signal
      // it back so the UI doesn't silently lie.
      socket.emit(SOCKET_EVENTS.error, {
        code: 'note_delete_failed',
        message: 'could not delete note',
      });
    }
  });

  // Internal notes: agents only.
  socket.on(SOCKET_EVENTS.noteAdd, async (raw: unknown) => {
    if (data.kind !== 'agent') return;
    if (!writeBucket.tryRemove())
      return socket.emit(SOCKET_EVENTS.error, {
        code: 'rate_limited',
        message: 'too many notes, slow down',
      });
    const parsed = NoteAdd.safeParse(raw);
    if (!parsed.success) return;
    const { conversationId, content, clientMsgId } = parsed.data;
    try {
      const saved = await directus.persistMessage({
        conversationId,
        senderType: 'agent',
        senderUser: data.agentId,
        content,
        isInternalNote: true,
      });
      // note:new goes to agents in the room (the widget filters internal notes out).
      io.to(rooms.conversation(conversationId)).emit(SOCKET_EVENTS.noteNew, {
        id: saved.id,
        conversationId,
        content,
        createdAt: saved.createdAt,
        clientMsgId,
        isInternalNote: true,
      });
    } catch (err) {
      logger.error({ err }, 'note:add failed');
    }
  });

  for (const evt of [SOCKET_EVENTS.typingStart, SOCKET_EVENTS.typingStop] as const) {
    socket.on(evt, (raw: unknown) => {
      const parsed = TypingSignal.safeParse(raw);
      if (!parsed.success) return;
      // IDOR guard: customers may only signal typing on their bound conversation.
      if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;
      socket.to(rooms.conversation(parsed.data.conversationId)).emit(SOCKET_EVENTS.typingUpdate, {
        conversationId: parsed.data.conversationId,
        who: data.kind,
        isTyping: evt === SOCKET_EVENTS.typingStart,
      });
    });
  }

  socket.on(SOCKET_EVENTS.readAck, (raw: unknown) => {
    const parsed = ReadAck.safeParse(raw);
    if (!parsed.success) return;
    // IDOR guard: a customer may only ack reads on its own bound conversation
    // (otherwise a customer could spoof read receipts into another thread).
    if (data.kind === 'customer' && parsed.data.conversationId !== data.conversationId) return;
    // An agent reading the thread clears its unread counter. Fire-and-forget;
    // a failed reset is non-fatal (next agent message resets it anyway).
    if (data.kind === 'agent') {
      directus
        .markConversationRead(parsed.data.conversationId)
        .catch((err) => logger.warn({ err }, 'markConversationRead failed'));
    }
    socket
      .to(rooms.conversation(parsed.data.conversationId))
      .emit(SOCKET_EVENTS.readAck, parsed.data);
  });

  // Customer CSAT (post-close survey from the widget). We trust the socket's
  // authenticated conversation/contact, not the payload's conversationId, and
  // persist at most one rating per conversation.
  socket.on(SOCKET_EVENTS.csatSubmit, (raw: unknown) => {
    if (data.kind !== 'customer' || !data.conversationId || !data.contactId) return;
    const parsed = CsatSubmit.safeParse(raw);
    if (!parsed.success) {
      return socket.emit(SOCKET_EVENTS.error, { code: 'bad_payload', message: 'invalid csat' });
    }
    if (parsed.data.conversationId !== data.conversationId) return;
    directus
      .persistCsat({
        conversationId: data.conversationId,
        contactId: data.contactId,
        score: parsed.data.score,
        comment: parsed.data.comment,
      })
      .catch((err) => logger.error({ err: extractAuthError(err) }, 'csat persist failed'));
  });

  // An agent opening a conversation joins its room to receive realtime messages,
  // regardless of when the conversation was created.
  socket.on(SOCKET_EVENTS.conversationSubscribe, (raw: unknown) => {
    if (data.kind !== 'agent') return;
    const parsed = TypingSignal.safeParse(raw);
    if (!parsed.success) return;
    void socket.join(rooms.conversation(parsed.data.conversationId));
  });

  // After an agent PATCHes a conversation (assignment / status / priority /
  // tags / etc.) they emit conversation:updated so every other connected agent
  // sees the change: peers in the conversation room get conversation:changed
  // (refetch this thread); everyone in agents:all gets inbox:activity (refresh
  // their inbox list).
  socket.on(SOCKET_EVENTS.conversationUpdated, async (raw: unknown) => {
    if (data.kind !== 'agent') return;
    const parsed = TypingSignal.safeParse(raw);
    if (!parsed.success) return;
    const { conversationId } = parsed.data;
    socket
      .to(rooms.conversation(conversationId))
      .emit(SOCKET_EVENTS.conversationChanged, { conversationId });
    io.to(rooms.agentsAll()).emit(SOCKET_EVENTS.inboxActivity, { conversationId });
    // If the update closed/resolved the conversation, tell the customer widget
    // (in the conversation room) so it surfaces the post-chat CSAT survey.
    try {
      const status = await directus.getConversationStatus(conversationId);
      if (status === 'solved' || status === 'closed' || status === 'resolved') {
        io.to(rooms.conversation(conversationId)).emit('conversation:closed', {
          conversationId,
          status,
        });
      }
    } catch (err) {
      logger.warn({ err }, 'conversation:closed status check failed');
    }
  });
}
