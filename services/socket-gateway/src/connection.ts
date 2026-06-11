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
import { validateAttachments, type AttachmentPolicy } from './attachments.js';
import { createTokenBucket } from './rate-limit.js';

interface SocketData {
  kind: 'customer' | 'agent';
  vendorId?: string; // CRM vendor UUID
  vendorColors?: unknown;
  contactId?: string;
  conversationId?: string;
  agentId?: string;
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
    const auth = socket.handshake.auth as { kind?: string; token?: string };
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
      const contactId = await directus.upsertContact(vendor.id, claims);
      const conversationId = await directus.findOrCreateConversation(vendor.id, contactId);
      data.kind = 'customer';
      data.vendorId = vendor.id;
      data.vendorColors = vendor.colors;
      data.contactId = contactId;
      data.conversationId = conversationId;
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
        agentPresence.remove(socket.id, false, () => broadcastAgentPresence(io));
      }
    });
  });
  logger.info('connection handlers registered');
}

async function onCustomerConnect(socket: Socket, { io }: ConnectionDeps): Promise<void> {
  const data = socket.data as SocketData;
  if (!data.conversationId || !data.vendorId) return;
  await socket.join(rooms.conversation(data.conversationId));
  await socket.join(rooms.vendor(data.vendorId));
  const online = addPresence(data.vendorId, socket.id);
  io.to(rooms.vendor(data.vendorId)).emit(SOCKET_EVENTS.presenceUpdate, {
    vendorId: data.vendorId,
    online,
  });
  // Tell the widget which conversation it is attached to + vendor branding,
  // plus the current agent-online count so it can render the offline
  // fallback on connect without waiting for the next agents:presence pulse.
  socket.emit('ready', {
    conversationId: data.conversationId,
    branding: data.vendorColors ?? null,
    agentsOnline: agentPresence.distinctOnline(),
  });
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
  // Separate, more generous bucket for attachment:get reads — opening a
  // conversation can fan out several asset fetches at once, and reads are
  // cheaper than writes, so they shouldn't compete with the message budget.
  const readBucket = createTokenBucket(rateLimit.capacity * 3, rateLimit.refillPerSec * 3);

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
    const { conversationId, content, attachments, clientMsgId } = parsed.data;
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
        conversationId,
        senderType,
        senderUser: data.kind === 'agent' ? data.agentId : undefined,
        senderContact: data.kind === 'customer' ? data.contactId : undefined,
        content,
        attachments,
      });
      const payload: MessageNew = {
        id: saved.id,
        conversationId,
        senderType,
        content,
        attachments: attachments ?? [],
        createdAt: saved.createdAt,
        clientMsgId,
      };
      io.to(rooms.conversation(conversationId)).emit(SOCKET_EVENTS.messageNew, payload);
      // Signal every agent inbox to refresh (covers conversations they haven't joined).
      io.to(rooms.agentsAll()).emit(SOCKET_EVENTS.inboxActivity, { conversationId });
      // Carry the message text so keyword-based automation rules can match.
      await producer.messageReceived(conversationId, content);
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
    const filename = typeof data?.filename === 'string' ? data.filename : 'upload';
    const mimetype = typeof data?.mimetype === 'string' ? data.mimetype.toLowerCase() : '';
    let buf: Buffer | null = null;
    if (data?.content instanceof ArrayBuffer) buf = Buffer.from(data.content);
    else if (ArrayBuffer.isView(data?.content as ArrayBufferView))
      buf = Buffer.from((data.content as ArrayBufferView).buffer);
    else if (typeof data?.content === 'string') buf = Buffer.from(data.content, 'base64');
    if (!buf || buf.length === 0) return respond({ ok: false, error: 'no file content' });
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

  // Attachment download — the mirror of the upload above. Customers have no
  // Directus account, so they can't fetch a private /assets/:id themselves; the
  // gateway streams the bytes on their behalf, but ONLY for files that belong
  // to their own conversation (authorization via attachmentInConversation).
  //   emit('attachment:get', { id }, (res) => ...)
  //   ack res: { ok:true, content:ArrayBuffer, type, filename } | { ok:false, error }
  socket.on('attachment:get', async (raw: unknown, ack?: (res: unknown) => void) => {
    const respond = typeof ack === 'function' ? ack : () => undefined;
    if (!readBucket.tryRemove()) return respond({ ok: false, error: 'rate_limited' });
    const id = (raw as { id?: unknown })?.id;
    if (typeof id !== 'string' || !id) return respond({ ok: false, error: 'bad_request' });
    try {
      // Customers may only read attachments from their own conversation. Agents
      // already hold Directus asset access via their own token, so the gateway
      // doesn't restrict them further here.
      if (data.kind === 'customer') {
        if (
          !data.conversationId ||
          !(await directus.attachmentInConversation(id, data.conversationId))
        )
          return respond({ ok: false, error: 'forbidden' });
      }
      const file = await directus.fetchFileBytes(id);
      if (!file) return respond({ ok: false, error: 'not_found' });
      respond({ ok: true, content: file.content, type: file.type, filename: file.filename });
    } catch (err) {
      logger.error({ err }, 'attachment:get failed');
      respond({ ok: false, error: 'fetch_failed' });
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
        conversationId,
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
  socket.on(SOCKET_EVENTS.conversationUpdated, (raw: unknown) => {
    if (data.kind !== 'agent') return;
    const parsed = TypingSignal.safeParse(raw);
    if (!parsed.success) return;
    const { conversationId } = parsed.data;
    socket
      .to(rooms.conversation(conversationId))
      .emit(SOCKET_EVENTS.conversationChanged, { conversationId });
    io.to(rooms.agentsAll()).emit(SOCKET_EVENTS.inboxActivity, { conversationId });
  });
}
