import { z } from 'zod';
import { ConversationStatus, SenderType } from './enums.js';

// Directus uses either UUID strings or auto-increment integers as primary
// keys depending on collection setup. Accept either at the wire boundary and
// normalise to string for room names and equality comparisons.
const idSchema = z.union([z.string(), z.number()]).transform(String);

/**
 * Socket.IO event payloads (contracts/socket-gateway.events.md).
 * Shared by the gateway, the agent portal, and the chat widget so realtime
 * payloads cannot drift.
 */

// --- Client → Server ---
export const MessageSend = z.object({
  conversationId: idSchema,
  content: z.string().min(1),
  attachments: z.array(z.string()).optional(),
  clientMsgId: z.string(),
});
export type MessageSend = z.infer<typeof MessageSend>;

export const NoteAdd = z.object({
  conversationId: idSchema,
  content: z.string().min(1),
  mentions: z.array(z.string()).optional(),
  clientMsgId: z.string(),
});
export type NoteAdd = z.infer<typeof NoteAdd>;

export const TypingSignal = z.object({ conversationId: z.string() });
export type TypingSignal = z.infer<typeof TypingSignal>;

export const ReadAck = z.object({
  conversationId: idSchema,
  lastMessageId: idSchema,
});
export type ReadAck = z.infer<typeof ReadAck>;

export const CsatSubmit = z.object({
  conversationId: idSchema,
  score: z.number().int().min(1).max(5),
  comment: z.string().optional(),
});
export type CsatSubmit = z.infer<typeof CsatSubmit>;

// --- Server → Client ---
export const MessageNew = z.object({
  id: idSchema,
  conversationId: idSchema,
  senderType: SenderType,
  content: z.string(),
  attachments: z.array(z.string()).default([]),
  createdAt: z.string(),
  clientMsgId: z.string().optional(),
});
export type MessageNew = z.infer<typeof MessageNew>;

export const TypingUpdate = z.object({
  conversationId: idSchema,
  who: z.string(),
  isTyping: z.boolean(),
});
export type TypingUpdate = z.infer<typeof TypingUpdate>;

export const AgentAssigned = z.object({
  conversationId: idSchema,
  agentId: z.string().nullable(),
  teamId: z.string().nullable(),
});
export type AgentAssigned = z.infer<typeof AgentAssigned>;

export const ConversationStatusChanged = z.object({
  conversationId: idSchema,
  status: ConversationStatus,
});
export type ConversationStatusChanged = z.infer<typeof ConversationStatusChanged>;

export const PresenceUpdate = z.object({
  vendorId: z.string(),
  online: z.array(z.string()),
});
export type PresenceUpdate = z.infer<typeof PresenceUpdate>;

export const SocketError = z.object({ code: z.string(), message: z.string() });
export type SocketError = z.infer<typeof SocketError>;

/** Event name constants (avoid stringly-typed mismatches). */
export const SOCKET_EVENTS = {
  // client → server
  messageSend: 'message:send',
  noteAdd: 'note:add',
  typingStart: 'typing:start',
  typingStop: 'typing:stop',
  readAck: 'read:ack',
  csatSubmit: 'csat:submit',
  conversationSubscribe: 'conversation:subscribe',
  conversationUpdated: 'conversation:updated',
  // server → client
  inboxActivity: 'inbox:activity',
  conversationChanged: 'conversation:changed',
  messageNew: 'message:new',
  noteNew: 'note:new',
  typingUpdate: 'typing:update',
  agentAssigned: 'agent:assigned',
  conversationStatusChanged: 'conversation:status_changed',
  presenceUpdate: 'presence:update',
  /** Server → client. Agent-presence pulse broadcast to every vendor room
   * so customer widgets can render an "agents offline" fallback. */
  agentsPresence: 'agents:presence',
  notificationPushed: 'notification:pushed',
  error: 'error',
} as const;

/** Room name helpers. */
export const rooms = {
  conversation: (id: string) => `conversation:${id}`,
  agent: (userId: string) => `agent:${userId}`,
  vendor: (vendorId: string) => `vendor:${vendorId}`,
  /** Shared room all connected agents join — used for inbox activity signals. */
  agentsAll: () => 'agents:all',
};
