/**
 * WHERE A MESSAGE'S WORDS CAME FROM (owner, 2026-10-07).
 *
 * Recorded on every message so the canned and AI-written replies agents really
 * send — and the conversations they send them in — can be studied before any
 * of it is automated. One function decides it, so the gateway and the tests
 * cannot disagree.
 */
export type MessageSource =
  | 'customer'
  | 'typed'
  | 'quick_reply'
  | 'ai_suggestion'
  | 'ai_enhance'
  | 'auto_welcome'
  | 'internal_note'
  | 'system'
  /* Maha (owner, 2026-11-09): her answer, her handover line, and the
     "<name> is with you" line before the agent's first message. All three are
     automated (no sender_user). */
  | 'maha_intro'
  | 'maha'
  | 'maha_handover'
  | 'agent_joined';

export interface ComposerOrigin {
  source: 'quick_reply' | 'ai_suggestion' | 'ai_enhance';
  quickReplyId?: string;
  /** The exact text the composer inserted. */
  text: string;
}

export interface MessageSourceFields {
  source: MessageSource;
  quick_reply_id: string | null;
  source_text: string | null;
  source_edited: boolean | null;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function messageSourceFields(input: {
  senderType: 'customer' | 'agent' | 'system';
  senderUser?: string | null;
  isInternalNote?: boolean;
  content: string;
  origin?: ComposerOrigin | null;
  /** Which automated message this is, when it is not the plain welcome. */
  automatedSource?: 'maha_intro' | 'maha' | 'maha_handover' | 'agent_joined';
}): MessageSourceFields {
  const none = { quick_reply_id: null, source_text: null, source_edited: null };
  if (input.senderType === 'customer') return { source: 'customer', ...none };
  if (input.senderType === 'system') return { source: 'system', ...none };
  if (input.isInternalNote) return { source: 'internal_note', ...none };
  // An agent-style message with no person behind it is the automatic welcome.
  if (!input.senderUser) return { source: input.automatedSource ?? 'auto_welcome', ...none };
  const o = input.origin;
  if (!o || !o.text.trim()) return { source: 'typed', ...none };
  return {
    source: o.source,
    quick_reply_id: o.source === 'quick_reply' ? (o.quickReplyId ?? null) : null,
    source_text: o.text,
    // Whitespace-only differences are not an edit.
    source_edited: norm(o.text) !== norm(input.content),
  };
}
