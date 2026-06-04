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

  constructor(url: string, token: string) {
    this.client = createServiceClient({ url, token });
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
