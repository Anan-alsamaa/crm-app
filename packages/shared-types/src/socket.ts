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
export const MessageSend = z
  .object({
    /**
     * Optional, because a customer's FIRST message is what creates the
     * conversation — until then the widget has no id to send.
     *
     * The gateway resolves the real conversation for a customer socket and
     * refuses any id that is not the one that socket owns, so making this
     * optional does not weaken the IDOR guard. Agents always send it.
     */
    conversationId: idSchema.optional(),
    // Content may be empty for an attachment-only message; the refine below
    // still rejects a message that has neither text nor an attachment.
    content: z.string(),
    attachments: z.array(z.string()).optional(),
    clientMsgId: z.string(),
    /**
     * What the agent's composer inserted before this was sent (owner,
     * 2026-10-07): a quick reply, an AI suggestion or an AI enhancement, and
     * the exact text inserted. Recorded, never trusted for anything else.
     */
    origin: z
      .object({
        source: z.enum(['quick_reply', 'ai_suggestion', 'ai_enhance']),
        quickReplyId: z.string().max(64).optional(),
        text: z.string().max(20000),
      })
      .optional(),
  })
  .refine((d) => d.content.trim().length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: 'message must have text or at least one attachment',
  });
export type MessageSend = z.infer<typeof MessageSend>;

export const NoteAdd = z.object({
  conversationId: idSchema,
  content: z.string().min(1),
  mentions: z.array(z.string()).optional(),
  clientMsgId: z.string(),
});
export type NoteAdd = z.infer<typeof NoteAdd>;

export const NoteDelete = z.object({
  conversationId: idSchema,
  noteId: idSchema,
});
export type NoteDelete = z.infer<typeof NoteDelete>;

/**
 * Agent → server: correct a reply they sent (owner, 2026-10-05 (EMA-33)).
 * Since 2026-10-07 the customer widget sends it too, for the customer's own
 * messages (owner: "the customer must have this option too"). The gateway re-reads the row and enforces own-message + the 15-minute window
 * (see message-edit.ts); this schema only shapes the request. Trimmed and
 * non-empty, because an edit to nothing is a delete and has its own event.
 */
export const MessageEdit = z.object({
  conversationId: idSchema,
  messageId: idSchema,
  content: z.string().trim().min(1),
});
export type MessageEdit = z.infer<typeof MessageEdit>;

/** Agent or customer → server: withdraw a message they sent (soft delete). */
export const MessageDelete = z.object({
  conversationId: idSchema,
  messageId: idSchema,
});
export type MessageDelete = z.infer<typeof MessageDelete>;

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
  /**
   * The sending agent's user id, so the portal can tell its OWN live replies
   * apart and offer Edit/Delete on them (EMA-33). Absent for customer messages.
   */
  senderUserId: z.string().optional(),
  /**
   * True for the automatic welcome (owner, 2026-10-06): an agent-STYLE message
   * no person sent. Rendered as an agent bubble, but never proof an agent is
   * present or has answered — see `isAutomatedAgentMessage`.
   */
  automated: z.boolean().optional(),
});
export type MessageNew = z.infer<typeof MessageNew>;

/** Server → conversation room (agents AND the customer): a message was edited. */
export const MessageEdited = z.object({
  conversationId: idSchema,
  messageId: idSchema,
  content: z.string(),
  editedAt: z.string(),
});
export type MessageEdited = z.infer<typeof MessageEdited>;

/**
 * Server → conversation room: a reply was withdrawn. Carries no content on
 * purpose — every surface renders a "This message was deleted" placeholder.
 */
export const MessageDeleted = z.object({
  conversationId: idSchema,
  messageId: idSchema,
  deletedAt: z.string(),
});
export type MessageDeleted = z.infer<typeof MessageDeleted>;

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

/** Server → conversation room. Customer connect/disconnect, delivered to the
 * agents viewing that conversation — powers the header's "{name} is online" /
 * "New customer" line. `isNew` is true only on the customer's first-ever
 * contact (the gateway had to create the contact row). */
export const CustomerPresence = z.object({
  conversationId: idSchema,
  online: z.boolean(),
  isNew: z.boolean().optional(),
});
export type CustomerPresence = z.infer<typeof CustomerPresence>;

export const SocketError = z.object({ code: z.string(), message: z.string() });
export type SocketError = z.infer<typeof SocketError>;

/** Event name constants (avoid stringly-typed mismatches). */
export const SOCKET_EVENTS = {
  // client → server
  messageSend: 'message:send',
  noteAdd: 'note:add',
  noteDelete: 'note:delete',
  /** Agent → server. Edit / soft-delete their own reply within 15 minutes (EMA-33). */
  messageEdit: 'message:edit',
  messageDelete: 'message:delete',
  /** Client → server. Explicit "I'm logging out" signal from an agent so the
   * gateway can drop their presence record before the transport closes. */
  agentLogout: 'agent:logout',
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
  /** Server → conversation room (agents + the customer widget). */
  messageEdited: 'message:edited',
  messageDeleted: 'message:deleted',
  noteNew: 'note:new',
  noteDeleted: 'note:deleted',
  typingUpdate: 'typing:update',
  agentAssigned: 'agent:assigned',
  conversationStatusChanged: 'conversation:status_changed',
  presenceUpdate: 'presence:update',
  /** Server → conversation room. Customer online/offline for the agents
   * viewing that conversation (header "is online" / "New customer"). */
  customerPresence: 'customer:presence',
  /** Server → client. Agent-presence pulse broadcast to every vendor room
   * so customer widgets can render an "agents offline" fallback. */
  agentsPresence: 'agents:presence',
  /**
   * Server → one customer socket. The id of that customer's most recent Yiji
   * order, used to prefill the WhatsApp fallback so an offline handover starts
   * with the order already named.
   *
   * Sent after `ready` rather than inside it: the upstream call is large and
   * slow, and must never sit in front of the handshake.
   */
  customerLatestOrder: 'customer:latest-order',
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
