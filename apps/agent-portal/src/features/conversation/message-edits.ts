import { canEditMessage, type MessageDeleted, type MessageEdited } from '@yiji/shared-types';
import type { ConversationMessage } from '../inbox/api.js';

/*
 * Applying an agent's edit or delete to what is on screen (owner, 2026-10-05
 * (EMA-33)).
 *
 * The thread is the merge of two lists — the `['messages', id]` query cache and
 * the live socket buffer — and a message can sit in either. Both are patched
 * with these helpers, or an edit would show in one place and be undone by the
 * other on the next merge.
 */

/** Replace the edited message's wording and stamp it "edited". */
export function applyMessageEdited(
  list: ConversationMessage[],
  e: Pick<MessageEdited, 'messageId' | 'content' | 'editedAt'>,
): ConversationMessage[] {
  let changed = false;
  const next = list.map((m) => {
    if (m.id !== e.messageId || m.deleted_at) return m;
    changed = true;
    return { ...m, content: e.content, edited_at: e.editedAt };
  });
  return changed ? next : list;
}

/**
 * Turn the message into a placeholder: no words, no files. The row stays in
 * place so the thread keeps its shape and the agent can see that something was
 * withdrawn, exactly as the customer does.
 */
export function applyMessageDeleted(
  list: ConversationMessage[],
  e: Pick<MessageDeleted, 'messageId' | 'deletedAt'>,
): ConversationMessage[] {
  let changed = false;
  const next = list.map((m) => {
    if (m.id !== e.messageId) return m;
    changed = true;
    return { ...m, content: '', attachments: [], deleted_at: e.deletedAt };
  });
  return changed ? next : list;
}

/**
 * Whether to OFFER Edit/Delete on this message. Only a convenience — the
 * gateway re-checks every rule — so it errs towards hiding: an optimistic
 * message still waiting for its id is never offered.
 */
export function canOfferMessageActions(
  m: ConversationMessage,
  agentId: string | null | undefined,
  nowMs: number,
): boolean {
  if (m.pending) return false;
  return canEditMessage(m, agentId, nowMs);
}
