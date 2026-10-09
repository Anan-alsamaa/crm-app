import type { Logger } from 'pino';
import type { NotificationJob } from '@yiji/shared-types';

/**
 * Chat-note mentions (`mention` NotificationType, owner 2026-10-09).
 *
 * The portal resolved `@name` in an internal note to user ids and sent them as
 * `mentions` on `note:add` — and the gateway dropped them, so a colleague
 * pulled into a chat by name was never told.
 *
 * The ids come from the client, so they are only a REQUEST: each one must be
 * an ACTIVE staff user (re-read here with the service token), the author is
 * never notified of their own note, and the list is capped. The copy is built
 * here; the client supplies no title or link.
 */

/** More than this in one note is not a mention, it is a broadcast. */
export const MAX_MENTIONS = 20;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PREVIEW_CHARS = 140;

export interface StaffUser {
  id: string;
  name: string | null;
}

export interface MentionNotifyDeps {
  /** ACTIVE users among `ids` (unknown / suspended ids are simply absent). */
  activeUsers(ids: string[]): Promise<StaffUser[]>;
  /** Enqueue onto the `notifications` queue; null when Redis is disabled. */
  enqueueNotification(job: NotificationJob, jobId: string): Promise<string | null>;
  logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
}

export interface NoteMention {
  noteId: string;
  conversationId: string;
  authorId: string;
  content: string;
  mentions: string[] | undefined;
}

/** The ids worth looking up: unique, well-formed, not the author, capped. */
export function mentionCandidates(mentions: string[] | undefined, authorId: string): string[] {
  const ids = new Set<string>();
  for (const raw of mentions ?? []) {
    const id = raw.trim();
    if (id && id !== authorId && OPAQUE_ID.test(id)) ids.add(id);
  }
  return [...ids].slice(0, MAX_MENTIONS);
}

export function buildMentionNotification(
  note: Omit<NoteMention, 'mentions'>,
  recipientId: string,
  authorName: string | null,
): NotificationJob {
  const text = note.content.trim().replace(/\s+/g, ' ');
  const preview = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
  return {
    recipientId,
    type: 'mention',
    title: `${authorName?.trim() || 'A colleague'} mentioned you in a chat note`,
    body: preview,
    // Inbox deep-link (pages/Inbox.tsx reads ?conv=<id>).
    link: `/?conv=${note.conversationId}`,
    payload: {
      entityType: 'conversation',
      conversationId: note.conversationId,
      messageId: note.noteId,
    },
  };
}

/** One job per note per person: a retried note cannot notify twice. */
export function mentionJobId(noteId: string, recipientId: string): string {
  return `mention-${noteId}-${recipientId}`;
}

/** Returns how many notifications were queued. Never throws: the note is already saved. */
export async function notifyNoteMentions(
  deps: MentionNotifyDeps,
  note: NoteMention,
): Promise<number> {
  const candidates = mentionCandidates(note.mentions, note.authorId);
  if (candidates.length === 0) return 0;
  try {
    const users = await deps.activeUsers([...candidates, note.authorId]);
    const author = users.find((u) => u.id === note.authorId)?.name ?? null;
    const recipients = users.filter((u) => u.id !== note.authorId && candidates.includes(u.id));
    let queued = 0;
    for (const r of recipients) {
      const id = await deps.enqueueNotification(
        buildMentionNotification(note, r.id, author),
        mentionJobId(note.noteId, r.id),
      );
      if (id !== null) queued++;
    }
    deps.logger.info(
      { conversationId: note.conversationId, noteId: note.noteId, queued },
      'note mentions notified',
    );
    return queued;
  } catch (err) {
    deps.logger.warn({ err, noteId: note.noteId }, 'note mention notify failed');
    return 0;
  }
}
