import { readItems, readItem } from '@directus/sdk';
import { createServiceClient, type YijiDirectusClient } from '@yiji/shared-config';

/**
 * Typed Directus client for the gateway. Gateway only READS — never writes
 * (Directus is the sole writer in this architecture). Auth is via a static
 * service-account token.
 */

export interface ConversationContext {
  id: string;
  status: string;
  priority: string;
  contact: { id: string; name: string | null; email: string | null } | null;
  vendor: string;
  messages: Array<{
    id: string;
    sender_type: string;
    content: string;
    is_internal_note: boolean;
    date_created: string;
  }>;
}

/** One searchable conversation + a short representative text blob. */
export interface ConversationSnippet {
  /** Conversation id. */
  id: string;
  /** Truncated, chronological excerpt of the conversation's latest messages. */
  text: string;
}

export interface SnippetCorpusOptions {
  /** Vendor scope. Empty/undefined = no vendor filter (see routes.ts). */
  vendorId?: string;
  /** Max conversations pulled into the corpus (clamped to 1..100). */
  conversationLimit?: number;
  /** Max messages sampled per conversation (clamped to 1..10). */
  messagesPerConversation?: number;
  /** Max characters per snippet (clamped to 80..2000). */
  snippetChars?: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/**
 * A silence this long between two messages ends a session. Six hours: long
 * enough that a customer who stepped out for lunch mid-complaint stays in one
 * session, short enough that "last month's missing burger" never leaks into
 * today's late delivery.
 */
const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Cut a NEWEST-FIRST message list down to the current session and return it in
 * reading order (oldest → newest).
 *
 * Walks back from the latest message and stops at the first idle gap longer
 * than SESSION_GAP_MS — everything before that silence is a previous case.
 * Edge cases, resolved toward keeping context rather than losing the current
 * message: an unparseable or missing timestamp never ends the session (a cut
 * there could orphan the very message the agent is answering), and a thread
 * with no long gaps is returned whole (the read is already capped upstream).
 */
export function sessionSlice(
  newestFirst: ConversationContext['messages'],
): ConversationContext['messages'] {
  const session: ConversationContext['messages'] = [];
  let prevTime: number | null = null;
  for (const m of newestFirst) {
    const t = Date.parse(m.date_created ?? '');
    if (prevTime !== null && Number.isFinite(t) && prevTime - t > SESSION_GAP_MS) break;
    session.push(m);
    if (Number.isFinite(t)) prevTime = t;
  }
  return session.reverse();
}

export class GatewayDirectus {
  private readonly client: YijiDirectusClient;
  private readonly url: string;
  private readonly token: string;
  // Small caches so we don't hit Directus on every AI request.
  private adminRoleCache: { ids: Set<string>; at: number } | null = null;
  private readonly whoCache = new Map<
    string,
    { who: { id: string; role: string | null }; at: number }
  >();

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.client = createServiceClient({ url, token });
  }

  /**
   * Resolve a caller-supplied Directus access token to its user id + role id by
   * calling /users/me AS THAT TOKEN. Returns null when the token is
   * invalid/expired (non-2xx). Cached briefly to avoid a round-trip per request.
   */
  async whoAmI(callerToken: string): Promise<{ id: string; role: string | null } | null> {
    if (!callerToken) return null;
    const hit = this.whoCache.get(callerToken);
    const now = Date.now();
    if (hit && now - hit.at < 60_000) return hit.who;
    try {
      const res = await fetch(`${this.url}/users/me?fields=id,role`, {
        headers: { authorization: `Bearer ${callerToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { id?: string; role?: string | null } };
      const id = body.data?.id;
      if (!id) return null;
      const who = { id, role: body.data?.role ?? null };
      this.whoCache.set(callerToken, { who, at: now });
      return who;
    } catch {
      return null;
    }
  }

  /**
   * Directus role ids that are admin roles (business "Admin" + schema
   * "Administrator"), resolved via the gateway's service token (authoritative —
   * not influenced by the caller). Cached for 5 minutes.
   */
  async adminRoleIds(): Promise<Set<string>> {
    const now = Date.now();
    if (this.adminRoleCache && now - this.adminRoleCache.at < 300_000) {
      return this.adminRoleCache.ids;
    }
    try {
      const res = await fetch(
        `${this.url}/roles?filter[name][_in]=Admin,Administrator&fields=id&limit=-1`,
        {
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = new Set((body.data ?? []).map((r) => r.id));
      this.adminRoleCache = { ids, at: now };
      return ids;
    } catch {
      // On failure, fall back to the last known set (or empty → no admin access),
      // which fails CLOSED for admin-gated endpoints.
      return this.adminRoleCache?.ids ?? new Set<string>();
    }
  }

  /**
   * Fetch the conversation header + the CURRENT SESSION's messages (newest
   * last) so prompts speak to the issue the customer is raising now.
   *
   * A conversation here is long-lived — one thread per customer, reused across
   * visits — so "the conversation" and "the current case" are different sizes.
   * Feeding the whole thread made suggestions answer February's complaint in
   * August. Two cuts fix that:
   *
   *   1. The read takes the NEWEST messages. It used to sort ascending with a
   *      limit, which returned the OLDEST fifty — on a long thread the model
   *      never even saw the message the agent wanted answered.
   *
   *   2. `sessionSlice` drops everything before the last long idle gap. A
   *      support session is a burst of messages; hours of silence in between is
   *      the customer going away and coming back with a NEW case.
   */
  async getConversation(
    conversationId: string,
    messageLimit = 50,
  ): Promise<ConversationContext | null> {
    try {
      const conv = (await this.client.request(
        readItem('conversations', conversationId, {
          fields: [
            'id',
            'status',
            'priority',
            'vendor',
            'contact.id',
            'contact.name',
            'contact.email',
          ],
        }),
      )) as ConversationContext;
      if (!conv) return null;

      const newestFirst = (await this.client.request(
        readItems('messages', {
          filter: { conversation: { _eq: conversationId } },
          sort: ['-date_created'],
          limit: messageLimit,
          fields: ['id', 'sender_type', 'content', 'is_internal_note', 'date_created'],
        }),
      )) as ConversationContext['messages'];

      return { ...conv, messages: sessionSlice(newestFirst ?? []) };
    } catch {
      return null;
    }
  }

  /**
   * Build the semantic-search corpus: the most recently active conversations in
   * the caller's vendor scope, each reduced to one short text blob taken from
   * its latest customer/agent messages (internal notes excluded).
   *
   * Bounded on purpose — the whole corpus is inlined into one LLM prompt, so we
   * cap both the conversation count and the per-conversation character budget.
   *
   * Unlike `getConversation`, failures are NOT swallowed: the caller needs to
   * tell "Directus is down" (fail soft, skip the provider call) apart from
   * "this vendor genuinely has no conversations".
   */
  async listConversationSnippets(opts: SnippetCorpusOptions = {}): Promise<ConversationSnippet[]> {
    const conversationLimit = clamp(opts.conversationLimit ?? 50, 1, 100);
    const perConversation = clamp(opts.messagesPerConversation ?? 4, 1, 10);
    const snippetChars = clamp(opts.snippetChars ?? 500, 80, 2000);

    const convs = (await this.client.request(
      readItems('conversations', {
        ...(opts.vendorId ? { filter: { vendor: { _eq: opts.vendorId } } } : {}),
        // Most recently active first; fall back to creation order for rows that
        // have never received a message.
        sort: ['-last_message_at', '-date_created'],
        limit: conversationLimit,
        fields: ['id'],
      }),
    )) as Array<{ id: string }> | null;

    const ids = (convs ?? []).map((c) => c.id).filter(Boolean);
    if (ids.length === 0) return [];

    // One batched read for every candidate conversation rather than N round-trips.
    const messages = (await this.client.request(
      readItems('messages', {
        filter: {
          _and: [{ conversation: { _in: ids } }, { is_internal_note: { _eq: false } }],
        },
        sort: ['-date_created'],
        limit: ids.length * perConversation,
        fields: ['conversation', 'sender_type', 'content', 'date_created'],
      }),
    )) as Array<{
      conversation: string;
      sender_type: string;
      content: string | null;
    }> | null;

    // Group newest-first, keep at most `perConversation` per conversation.
    const byConversation = new Map<string, string[]>();
    for (const m of messages ?? []) {
      const content = (m.content ?? '').trim();
      if (!content) continue;
      const bucket = byConversation.get(m.conversation) ?? [];
      if (bucket.length >= perConversation) continue;
      bucket.push(`${m.sender_type === 'agent' ? 'Agent' : 'Customer'}: ${content}`);
      byConversation.set(m.conversation, bucket);
    }

    const out: ConversationSnippet[] = [];
    for (const id of ids) {
      const lines = byConversation.get(id);
      if (!lines || lines.length === 0) continue; // nothing to rank on
      // Stored newest-first; flip back to reading order before truncating.
      const text = lines.slice().reverse().join(' / ').slice(0, snippetChars);
      out.push({ id, text });
    }
    return out;
  }
}
