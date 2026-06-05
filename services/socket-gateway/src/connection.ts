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
  type MessageNew,
} from '@yiji/shared-types';
import type { GatewayDirectus } from './directus.js';
import type { CustomerVerifier } from './auth/customer-jwt.js';
import { CustomerTokenError } from './auth/customer-jwt.js';
import { validateAgentToken } from './auth/agent-jwt.js';
import type { SideEffectProducer } from './queue.js';
import { createAgentPresence } from './agent-presence.js';

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
      // Directus SDK rejects with a non-Error object ({ errors: [{ message }] }).
      // Don't collapse those to a useless "unauthorized" — surface the real
      // cause (permissions, invalid svc token, unreachable Directus, …) so
      // onboarding failures are diagnosable in the logs instead of opaque.
      const msg =
        err instanceof Error
          ? err.message
          : ((err as { errors?: Array<{ message?: string }> } | null)?.errors?.[0]?.message ??
            'unauthorized');
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
  const data = socket.data as SocketData;

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
    const parsed = MessageSend.safeParse(raw);
    if (!parsed.success)
      return socket.emit(SOCKET_EVENTS.error, { code: 'bad_payload', message: 'invalid message' });
    const { conversationId, content, attachments, clientMsgId } = parsed.data;
    try {
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
      await producer.messageReceived(conversationId);
    } catch (err) {
      logger.error({ err }, 'message:send failed');
      socket.emit(SOCKET_EVENTS.error, {
        code: 'persist_failed',
        message: 'could not send message',
      });
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
    socket
      .to(rooms.conversation(parsed.data.conversationId))
      .emit(SOCKET_EVENTS.readAck, parsed.data);
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
