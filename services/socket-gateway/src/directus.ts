import {
  readItems,
  readFiles,
  createItem,
  updateItem,
  deleteItem,
  uploadFiles,
} from '@directus/sdk';
import { createServiceClient, type YijiDirectusClient } from '@yiji/shared-config';
import type { SenderType } from '@yiji/shared-types';
import type { CustomerClaims } from './auth/customer-jwt.js';
import type { AttachmentMeta } from './attachments.js';

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

    // Link attachments through the messages_files m2m junction so they survive
    // a refetch (validated upstream in message:send). Failures here are logged
    // by the caller; we attach best-effort per file.
    if (input.attachments && input.attachments.length > 0) {
      for (const fileId of input.attachments) {
        await this.client.request(
          createItem('messages_files', {
            messages_id: created.id,
            directus_files_id: fileId,
          } as never),
        );
      }
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { last_message_at: now };
    // Unread bookkeeping (SC §7/§8): a customer message increments the agent's
    // unread counter; an agent reply means the agent is active, so it resets to
    // 0. Internal notes never touch the customer-facing unread count.
    if (!input.isInternalNote) {
      if (input.senderType === 'customer') {
        const rows = (await this.client.request(
          readItems('conversations', {
            filter: { id: { _eq: input.conversationId } },
            fields: ['unread_count_agent'],
            limit: 1,
          }),
        )) as Array<{ unread_count_agent: number | null }>;
        patch.unread_count_agent = (rows[0]?.unread_count_agent ?? 0) + 1;
      } else if (input.senderType === 'agent') {
        patch.unread_count_agent = 0;
      }
    }
    await this.client.request(updateItem('conversations', input.conversationId, patch as never));
    return { id: created.id, createdAt: now };
  }

  /**
   * Upload a file to Directus via the service account and return its metadata.
   * Used by the customer-widget upload path (customers have no Directus account,
   * so the gateway proxies the upload with its service token).
   */
  async uploadFile(
    content: Buffer,
    filename: string,
    mimetype: string,
  ): Promise<{ id: string; type: string | null; filesize: number | null }> {
    const form = new FormData();
    form.append('file', new Blob([content], { type: mimetype }), filename);
    const res = (await this.client.request(uploadFiles(form))) as {
      id: string;
      type: string | null;
      filesize: number | string | null;
    };
    return {
      id: res.id,
      type: res.type ?? null,
      filesize: res.filesize === null || res.filesize === undefined ? null : Number(res.filesize),
    };
  }

  /** Reset the agent unread counter when an agent reads the conversation. */
  async markConversationRead(conversationId: string): Promise<void> {
    await this.client.request(
      updateItem('conversations', conversationId, { unread_count_agent: 0 } as never),
    );
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

  /**
   * Resolve metadata for the given Directus file UUIDs (for attachment
   * MIME/size validation). Missing ids simply aren't returned, so the caller
   * treats "not found" as a rejection.
   */
  async getFilesMeta(ids: string[]): Promise<AttachmentMeta[]> {
    if (ids.length === 0) return [];
    const rows = (await this.client.request(
      readFiles({
        filter: { id: { _in: ids } },
        fields: ['id', 'type', 'filesize'],
        limit: ids.length,
      }),
    )) as Array<{ id: string; type: string | null; filesize: number | string | null }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type ?? null,
      // Directus returns filesize as a bigint string; coerce to number.
      filesize: r.filesize === null || r.filesize === undefined ? null : Number(r.filesize),
    }));
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
