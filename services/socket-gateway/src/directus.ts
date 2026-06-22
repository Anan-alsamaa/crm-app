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
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.client = createServiceClient({ url, token });
    // Kept for the raw asset fetch in getConversationAttachment (the SDK has no
    // "read file bytes" helper — we GET /assets/:id with the service token).
    this.url = url;
    this.token = token;
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

  /**
   * Upsert a contact, deduped per vendor by phone then email (SC-007). Returns
   * the id plus `isNew` (was created now vs. resumed) and the contact's stored
   * name/phone — the gateway feeds these into the widget's `ready` event so a
   * returning customer is greeted by name. For a resumed contact we return the
   * STORED name (which may have been set/edited by an agent), not the token's —
   * the customer JWT often carries a blank name.
   */
  async upsertContact(
    vendorUuid: string,
    claims: CustomerClaims,
  ): Promise<{ id: string; isNew: boolean; name: string | null; phone: string | null }> {
    // Normalize identity once: a missing OR blank/whitespace name/phone/email is
    // stored as null (not ""), so the agent UI's `name ?? "Unknown"` fallback and
    // the phone/email dedup behave consistently. Only customer_id + (usually)
    // phone are guaranteed by the host — name is often absent or a dummy value.
    const name = claims.name?.trim() || null;
    const phone = claims.phone?.trim() || null;
    const email = claims.email?.trim() || null;

    const findExisting = async (): Promise<{
      id: string;
      name: string | null;
      phone: string | null;
    } | null> => {
      const or: Array<Record<string, unknown>> = [];
      if (phone) or.push({ phone: { _eq: phone } });
      if (email) or.push({ email: { _eq: email } });
      if (or.length === 0) return null;
      const existing = (await this.client.request(
        readItems('contacts', {
          filter: { vendor: { _eq: vendorUuid }, _or: or },
          fields: ['id', 'name', 'phone'],
          limit: 1,
        }),
      )) as Array<{ id: string; name: string | null; phone: string | null }>;
      return existing[0] ?? null;
    };

    const existing = await findExisting();
    if (existing)
      return {
        id: existing.id,
        isNew: false,
        name: existing.name ?? null,
        phone: existing.phone ?? null,
      };

    try {
      const created = (await this.client.request(
        createItem('contacts', {
          vendor: vendorUuid,
          external_customer_id: claims.customer_id,
          name,
          phone,
          email,
        } as never),
      )) as { id: string };
      return { id: created.id, isNew: true, name, phone };
    } catch (err) {
      // The widget reconnects aggressively, so multiple onboarding flows can
      // race: each reads "not found" then races to create the same contact,
      // and all-but-one hit the (vendor, phone|email) partial-unique index.
      // That's not a real failure — re-query and return the contact the
      // winning create produced. Only rethrow if it genuinely doesn't exist.
      const raced = await findExisting();
      if (raced)
        return { id: raced.id, isNew: false, name: raced.name ?? null, phone: raced.phone ?? null };
      throw err;
    }
  }

  /**
   * Return the contact's open conversation, or create a new one. `created` is
   * true only when a fresh conversation was inserted — the caller uses it to
   * fire the `conversation_created` automation trigger exactly once.
   */
  async findOrCreateConversation(
    vendorUuid: string,
    contactId: string,
  ): Promise<{ id: string; created: boolean }> {
    const open = (await this.client.request(
      readItems('conversations', {
        filter: { contact: { _eq: contactId }, status: { _eq: 'open' } },
        fields: ['id'],
        sort: ['-last_message_at'],
        limit: 1,
      }),
    )) as Array<{ id: string }>;
    if (open[0]) return { id: open[0].id, created: false };

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
    return { id: created.id, created: true };
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
   * Record a customer's CSAT rating (post-close survey). At most one per
   * conversation (DB enforces uq_csat_conversation), so we pre-check and skip a
   * duplicate rather than relying on the service account having update rights.
   * Links conversations.csat_response so reports/agent UI can resolve it.
   */
  async persistCsat(input: {
    conversationId: string;
    contactId: string;
    score: number;
    comment?: string;
  }): Promise<void> {
    const existing = (await this.client.request(
      readItems('csat_responses', {
        filter: { conversation: { _eq: input.conversationId } },
        fields: ['id'],
        limit: 1,
      }),
    )) as Array<{ id: string }>;
    if (existing[0]) return; // already rated — one CSAT per conversation

    const created = (await this.client.request(
      createItem('csat_responses', {
        conversation: input.conversationId,
        contact: input.contactId,
        score: input.score,
        comment: input.comment?.trim() ? input.comment.trim() : null,
        submitted_at: new Date().toISOString(),
      } as never),
    )) as { id: string };

    await this.client.request(
      updateItem('conversations', input.conversationId, { csat_response: created.id } as never),
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

  /**
   * Load a conversation's visible message thread (customer + agent messages,
   * excluding internal notes) for the widget's `messages:history` seed on
   * (re)connect. Attachment ids come from the messages_files junction (there is
   * no alias field on `messages`); a denied junction read fails soft to no chips.
   */
  async loadConversationMessages(
    conversationId: string,
  ): Promise<
    Array<{
      id: string;
      senderType: SenderType;
      content: string;
      createdAt: string;
      attachments: string[];
    }>
  > {
    const msgs = (await this.client.request(
      readItems('messages', {
        filter: { conversation: { _eq: conversationId }, is_internal_note: { _eq: false } },
        fields: ['id', 'sender_type', 'content', 'date_created'],
        sort: ['date_created'],
        limit: 200,
      }),
    )) as Array<{ id: string; sender_type: SenderType; content: string; date_created: string }>;
    if (msgs.length === 0) return [];

    const byMessage = new Map<string, string[]>();
    try {
      const links = (await this.client.request(
        readItems('messages_files', {
          filter: { messages_id: { _in: msgs.map((m) => m.id) } },
          fields: ['messages_id', 'directus_files_id'],
          limit: -1,
        }),
      )) as Array<{ messages_id: string; directus_files_id: string | null }>;
      for (const l of links) {
        if (!l.directus_files_id) continue;
        const arr = byMessage.get(l.messages_id) ?? [];
        arr.push(l.directus_files_id);
        byMessage.set(l.messages_id, arr);
      }
    } catch {
      // Junction read denied (older permission set) — thread still loads, sans attachments.
    }

    return msgs.map((m) => ({
      id: m.id,
      senderType: m.sender_type,
      content: m.content,
      createdAt: m.date_created,
      attachments: byMessage.get(m.id) ?? [],
    }));
  }

  /** Current status of a conversation (used to detect close/resolve for CSAT). */
  async getConversationStatus(conversationId: string): Promise<string | null> {
    const rows = (await this.client.request(
      readItems('conversations', {
        filter: { id: { _eq: conversationId } },
        fields: ['status'],
        limit: 1,
      }),
    )) as Array<{ status: string | null }>;
    return rows[0]?.status ?? null;
  }

  /**
   * Fetch an attachment's bytes (base64) for the customer widget, but only if
   * the file is linked to a message in the given conversation — so a crafted
   * file id can't read another conversation's attachments. Returns null when
   * unauthorized / missing.
   */
  async getConversationAttachment(
    conversationId: string,
    fileId: string,
  ): Promise<{ content: string; type: string | null; filename: string | null } | null> {
    const links = (await this.client.request(
      readItems('messages_files', {
        filter: {
          directus_files_id: { _eq: fileId },
          messages_id: { conversation: { _eq: conversationId } },
        },
        fields: ['messages_id'],
        limit: 1,
      }),
    )) as Array<{ messages_id: string }>;
    if (links.length === 0) return null;

    const meta = (await this.client.request(
      readFiles({
        filter: { id: { _eq: fileId } },
        fields: ['type', 'filename_download'],
        limit: 1,
      }),
    )) as Array<{ type: string | null; filename_download: string | null }>;

    const res = await fetch(`${this.url}/assets/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      content: buf.toString('base64'),
      type: meta[0]?.type ?? null,
      filename: meta[0]?.filename_download ?? null,
    };
  }
}
