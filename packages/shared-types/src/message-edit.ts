import { isAutomatedAgentMessage } from './automated-message.js';

/**
 * Editing or deleting a chat message an agent already sent (owner, 2026-10-05
 * (EMA-33)).
 *
 * The rules, in one place so the gateway (which ENFORCES them) and the agent
 * portal (which only hides the buttons) cannot disagree. Since 2026-10-07 the
 * CUSTOMER may do the same to their own messages (see `MessageEditor`); the
 * agent rules below are unchanged:
 *
 *   - only an AGENT's message, and only the agent who SENT it — a colleague's
 *     reply, a customer's words and a system line are never editable;
 *   - never an internal note: notes already have their own delete, and they
 *     never reached the customer, so there is nothing to correct in front of
 *     them;
 *   - only within 15 minutes of sending. Past that the customer has very likely
 *     read it and acted on it, and quietly rewriting it would change the record
 *     of what we told them;
 *   - a deleted message stays deleted: it cannot be edited back to life or
 *     deleted twice.
 *
 * The window is measured from `date_created` (when the message was SENT), not
 * from the last edit, so a chain of edits cannot keep a message open forever.
 */

/** How long after sending an agent may still edit or delete a message. */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60_000;

/** Why an edit/delete was refused. These are also the socket error codes. */
export type MessageEditRefusal =
  | 'not_found'
  | 'not_own_message'
  | 'edit_window_closed'
  | 'already_deleted';

/** The fields of a `messages` row the rules look at. */
export interface EditableMessageRow {
  sender_type?: string | null;
  /** The sending agent's user id (Directus may hand back an expanded object). */
  sender_user?: string | { id?: string | null } | null;
  /** The sending CUSTOMER's contact id (customer edits, owner 2026-10-07). */
  sender_contact?: string | { id?: string | null } | null;
  /** The conversation the row belongs to — required to judge a customer edit. */
  conversation?: string | { id?: string | null } | null;
  is_internal_note?: boolean | null;
  date_created?: string | null;
  deleted_at?: string | null;
}

/**
 * WHO is asking to change the message (owner, 2026-10-07: customers may edit
 * and delete their own messages too, under the same 15-minute rule).
 *
 * A bare string is the agent id, which is what every caller passed before
 * customers could edit — kept so the agent path reads exactly as it did.
 *
 * A customer is identified by BOTH their contact and the one conversation
 * their socket is bound to. The contact alone is not enough: the same person
 * can have an older thread, and a widget must only ever reach into the thread
 * it is showing.
 */
export type MessageEditor =
  | string
  | { kind: 'agent'; agentId: string | null | undefined }
  | {
      kind: 'customer';
      contactId: string | null | undefined;
      conversationId: string | null | undefined;
    };

function relId(v: string | { id?: string | null } | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.id ?? null;
}

/** The window rules shared by both senders: not deleted, not too old. */
function windowRefusal(row: EditableMessageRow, nowMs: number): MessageEditRefusal | null {
  if (row.deleted_at) return 'already_deleted';
  const sent = Date.parse(row.date_created ?? '');
  if (!Number.isFinite(sent)) return 'edit_window_closed';
  if (nowMs - sent > MESSAGE_EDIT_WINDOW_MS) return 'edit_window_closed';
  return null;
}

/**
 * Why `editor` may NOT edit or delete this message right now, or `null` when
 * they may. `editor` is an agent id (string) or a {@link MessageEditor}.
 *
 * Total: a missing row, a missing sender id or an unparseable timestamp all
 * REFUSE. Failing open here would let a malformed row be rewritten by anyone.
 */
export function messageEditRefusal(
  row: EditableMessageRow | null | undefined,
  editor: MessageEditor | null | undefined,
  nowMs: number,
): MessageEditRefusal | null {
  if (!row) return 'not_found';
  if (editor && typeof editor === 'object' && editor.kind === 'customer') {
    /* A CUSTOMER (owner, 2026-10-07): only words they sent themselves, in the
       conversation their socket is bound to. An agent's reply, a system line
       or another customer's message is never theirs — and a row whose
       contact or conversation is unknown fails closed. */
    if (row.sender_type !== 'customer' || row.is_internal_note) return 'not_own_message';
    if (!editor.contactId || relId(row.sender_contact) !== editor.contactId)
      return 'not_own_message';
    if (!editor.conversationId || relId(row.conversation) !== editor.conversationId)
      return 'not_own_message';
    return windowRefusal(row, nowMs);
  }
  const agentId = typeof editor === 'string' ? editor : (editor?.agentId ?? null);
  if (row.sender_type !== 'agent' || row.is_internal_note) return 'not_own_message';
  /* The automatic welcome (owner, 2026-10-06) belongs to no agent, so it is
     nobody's to rewrite. Already implied by the ownership check below; said
     explicitly so a future "admins may edit anything" change cannot reach it. */
  if (isAutomatedAgentMessage(row)) return 'not_own_message';
  if (!agentId || relId(row.sender_user) !== agentId) return 'not_own_message';
  return windowRefusal(row, nowMs);
}

/** UI convenience: may the actions be offered at all? */
export function canEditMessage(
  row: EditableMessageRow | null | undefined,
  editor: MessageEditor | null | undefined,
  nowMs: number,
): boolean {
  return messageEditRefusal(row, editor, nowMs) === null;
}

/**
 * The audit value to write with an edit or delete.
 *
 * Set ONCE: the first edit or delete records the wording the customer actually
 * received; a later edit must not overwrite it with an intermediate draft.
 * Returns `undefined` when the column is already filled, so the caller leaves
 * it out of the patch entirely.
 */
export function originalContentPatch(row: {
  content?: string | null;
  original_content?: string | null;
}): string | undefined {
  if (row.original_content !== null && row.original_content !== undefined) return undefined;
  return row.content ?? '';
}
