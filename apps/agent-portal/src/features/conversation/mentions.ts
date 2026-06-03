/**
 * Extract `@email`-style mentions from internal-note content and resolve them
 * to user ids using the supplied directory. Returns the unique set of matched
 * user ids — used by the gateway/workers to enqueue mention notifications.
 */
export interface MentionableUser {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

/** Match `@token` where token is at least 2 chars and not preceded by a word char. */
const MENTION_RE = /(?:^|\s)@([\w.+-]{2,})/g;

export function extractMentionTokens(content: string): string[] {
  const tokens: string[] = [];
  for (const m of content.matchAll(MENTION_RE)) tokens.push(m[1]!.toLowerCase());
  return Array.from(new Set(tokens));
}

/** Resolve mention tokens to user ids by exact email-local-part or full email match. */
export function resolveMentions(content: string, users: MentionableUser[]): string[] {
  const tokens = new Set(extractMentionTokens(content));
  if (tokens.size === 0) return [];
  const ids: string[] = [];
  for (const u of users) {
    if (!u.email) continue;
    const lower = u.email.toLowerCase();
    const local = lower.split('@')[0] ?? '';
    if (tokens.has(lower) || tokens.has(local)) ids.push(u.id);
  }
  return Array.from(new Set(ids));
}
