import { readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
import { createServiceClient, type YijiDirectusClient } from '@yiji/shared-config';
import type { SenderType } from '@yiji/shared-types';
import type { CustomerClaims } from './auth/customer-jwt.js';

/**
 * Gateway persistence via the Directus service account. The gateway is the sole
 * writer of chat messages (research D-03). Handles vendor resolution, per-vendor
 * contact dedup, conversation resume/create, and message writes.
 */
export class GatewayDirectus {
  private readonly client: YijiDirectusClient;

  constructor(url: string, token: string) {
    this.client = createServiceClient({ url, token });
  }

  /** Resolve the CRM vendor UUID from the Yiji external vendor id (must be active). */
  async resolveVendor(yijiVendorId: string): Promise<{ id: string; colors: unknown } | null> {
    const rows = (await this.client.request(
      readItems('vendors', {
        filter: { yiji_vendor_id: { _eq: yijiVendorId }, status: { _eq: 'active' } },
        fields: ['id', 'colors'],
        limit: 1,
      }),
    )) as Array<{ id: string; colors: unknown }>;
    return rows[0] ?? null;
  }

  /** Upsert a contact, deduped per vendor by phone then email (SC-007). */
  async upsertContact(vendorUuid: string, claims: CustomerClaims): Promise<string> {
    const or: Array<Record<string, unknown>> = [];
    if (claims.phone) or.push({ phone: { _eq: claims.phone } });
    if (claims.email) or.push({ email: { _eq: claims.email } });

    const existing = (await this.client.request(
      readItems('contacts', {
        filter: { vendor: { _eq: vendorUuid }, _or: or },
        fields: ['id'],
        limit: 1,
      }),
    )) as Array<{ id: string }>;
    if (existing[0]) return existing[0].id;

    const created = (await this.client.request(
      createItem('contacts', {
        vendor: vendorUuid,
        external_customer_id: claims.customer_id,
        name: claims.name ?? null,
        phone: claims.phone ?? null,
        email: claims.email ?? null,
      } as never),
    )) as { id: string };
    return created.id;
  }

  /** Return the contact's open conversation, or create a new one. */
  async findOrCreateConversation(vendorUuid: string, contactId: string): Promise<string> {
    const open = (await this.client.request(
      readItems('conversations', {
        filter: { contact: { _eq: contactId }, status: { _eq: 'open' } },
        fields: ['id'],
        sort: ['-last_message_at'],
        limit: 1,
      }),
    )) as Array<{ id: string }>;
    if (open[0]) return open[0].id;

    const created = (await this.client.request(
      createItem('conversations', {
        vendor: vendorUuid,
        contact: contactId,
        status: 'open',
        priority: 'medium',
        unread_count_agent: 0,
        last_message_at: new Date().toISOString(),
      } as never),
    )) as { id: string };
    return created.id;
  }

  /** Persist a message and bump conversation activity. Returns the new message. */
  async persistMessage(input: {
    conversationId: string;
    senderType: SenderType;
    senderUser?: string;
    senderContact?: string;
    content: string;
    attachments?: string[];
    isInternalNote?: boolean;
  }): Promise<{ id: string; createdAt: string }> {
    const created = (await this.client.request(
      createItem('messages', {
        conversation: input.conversationId,
        sender_type: input.senderType,
        sender_user: input.senderUser ?? null,
        sender_contact: input.senderContact ?? null,
        content: input.content,
        is_internal_note: input.isInternalNote ?? false,
      } as never),
    )) as { id: string };

    const now = new Date().toISOString();
    await this.client.request(
      updateItem('conversations', input.conversationId, {
        last_message_at: now,
      } as never),
    );
    return { id: created.id, createdAt: now };
  }

  /**
   * Delete an internal note. Guarded server-side: we re-read the message and
   * verify it is in the claimed conversation and IS an internal note before
   * touching it, so a malformed client cannot delete a real customer/agent
   * message by ID. Returns true on delete, false if not found / not a note.
   */
  async deleteInternalNote(conversationId: string, messageId: string): Promise<boolean> {
    const rows = (await this.client.request(
      readItems('messages', {
        filter: { id: { _eq: messageId }, conversation: { _eq: conversationId } },
        fields: ['id', 'is_internal_note'],
        limit: 1,
      }),
    )) as Array<{ id: string; is_internal_note: boolean }>;
    if (!rows[0] || !rows[0].is_internal_note) return false;
    await this.client.request(deleteItem('messages', messageId));
    return true;
  }

  /** Conversations an agent may see (assigned to them or unassigned). */
  async listAgentConversationIds(agentId: string): Promise<string[]> {
    const rows = (await this.client.request(
      readItems('conversations', {
        filter: {
          _or: [{ assigned_agent: { _eq: agentId } }, { assigned_agent: { _null: true } }],
        },
        fields: ['id'],
        limit: -1,
      }),
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
