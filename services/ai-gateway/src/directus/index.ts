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
   * Fetch the conversation header + recent messages (newest last) so prompts
   * have the full thread context.
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

      const messages = (await this.client.request(
        readItems('messages', {
          filter: { conversation: { _eq: conversationId } },
          sort: ['date_created'],
          limit: messageLimit,
          fields: ['id', 'sender_type', 'content', 'is_internal_note', 'date_created'],
        }),
      )) as ConversationContext['messages'];

      return { ...conv, messages: messages ?? [] };
    } catch {
      return null;
    }
  }
}
