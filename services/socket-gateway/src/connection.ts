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
 * Agent presence — global across vendors. Agents serve every vendor in this
 * release, so a single count is enough. We count DISTINCT logged-in agents,
 * not raw sockets: one agent with three tabs open is still "one online".
 * That matches the operational rule the host page advertises — even a single
 * logged-in agent with the app open in any tab = online.
 *
 * - `agentSocketUser[socketId]` records which user a given socket belongs to,
 *   so on disconnect we know whose count to decrement without re-reading
 *   socket.data.
 * - `agentRefCount[userId]` is the number of live sockets for that agent.
 * - distinctAgentCount() = number of keys with refCount > 0.
 */
const agentSocketUser = new Map<string, string>();
const agentRefCount = new Map<string, number>();
function distinctAgentCount(): number {
  return agentRefCount.size;
}
function addAgentSocket(socketId: string, userId: string): void {
  agentSocketUser.set(socketId, userId);
  agentRefCount.set(userId, (agentRefCount.get(userId) ?? 0) + 1);
}
/** Returns true if this drop changed the distinct-user count (someone went offline). */
function removeAgentSocket(socketId: string): boolean {
  const userId = agentSocketUser.get(socketId);
  if (!userId) return false;
  agentSocketUser.delete(socketId);
  const next = (agentRefCount.get(userId) ?? 1) - 1;
  if (next <= 0) {
    agentRefCount.delete(userId);
    return true;
  }
  agentRefCount.set(userId, next);
  return false;
}
function broadcastAgentPresence(io: import('socket.io').Server): void {
  io.emit(SOCKET_EVENTS.agentsPresence, { count: distinctAgentCount() });
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
      const msg = err instanceof Error ? err.message : 'unauthorized';
      logger.warn({ kind: auth.kind, err: msg }, 'connection rejected');
      return next(new Error(msg));
    }
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    if (data.kind === 'customer') void onCustomerConnect(socket, deps);
    else if (data.agentId) {
      void onAgentConnect(socket, deps);
      const before = distinctAgentCount();
      addAgentSocket(socket.id, data.agentId);
      // Only broadcast when DISTINCT count changed (first tab from this
      // agent). Subsequent tabs from the same agent don't move the dial.
      if (distinctAgentCount() !== before) broadcastAgentPresence(io);
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
        // True only when the LAST tab for this agent closed (they went offline).
        if (removeAgentSocket(socket.id)) broadcastAgentPresence(io);
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
    agentsOnline: distinctAgentCount(),
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
  // crafted payload can't wipe a real customer message.
  socket.on(SOCKET_EVENTS.noteDelete, async (raw: unknown) => {
    if (data.kind !== 'agent') return;
    const parsed = NoteDelete.safeParse(raw);
    if (!parsed.success) return;
    const { conversationId, noteId } = parsed.data;
    try {
      const ok = await directus.deleteInternalNote(conversationId, noteId);
      if (!ok) return;
      io.to(rooms.conversation(conversationId)).emit(SOCKET_EVENTS.noteDeleted, {
        conversationId,
        noteId,
      });
    } catch (err) {
      logger.error({ err }, 'note:delete failed');
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
