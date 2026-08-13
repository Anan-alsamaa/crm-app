import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem, uploadFiles } from '@directus/sdk';
import {
  storeNotificationDraft,
  type Priority,
  type StoreNotificationSkip,
  type StoreSnapshot,
  type TicketStatus,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { notifyAssignmentBestEffort } from '../../lib/job-producer.js';
import type { TicketOrderSnapshot } from './OrderSnapshotCard.js';

export interface TicketAttachment {
  /** Junction-row id (for removal). */
  id: string;
  file: { id: string; filename: string | null; type: string | null } | null;
}

/**
 * The operations team's complaint columns, carried on every ticket. All
 * nullable — tickets predate them and not every ticket is a complaint.
 * Values are their own vocabulary (see ComplaintType in @yiji/shared-types);
 * the two coupon numbers are real numbers so compensation can be summed.
 */
export interface TicketComplaintFields {
  /** When the complaint happened, as opposed to when the ticket was raised. */
  complaint_date: string | null;
  complaint_type: string | null;
  service_type: string | null;
  complaint_source: string | null;
  communication_method: string | null;
  response_desc: string | null;
  compensation: string | null;
  coupon_code: string | null;
  coupon_value: number | null;
  coupon_percent: number | null;
}

/** Field names as Directus stores them — reused by every read that needs them. */
export const COMPLAINT_FIELDS = [
  'complaint_date',
  'complaint_type',
  'service_type',
  'complaint_source',
  'communication_method',
  'response_desc',
  'compensation',
  'coupon_code',
  'coupon_value',
  'coupon_percent',
] as const;

export interface TicketRow extends Partial<TicketComplaintFields> {
  id: string;
  subject: string;
  description: string | null;
  /** Structured point-in-time copy of the order the ticket is about. */
  order_snapshot?: TicketOrderSnapshot | null;
  /** Searchable copy of order_snapshot.orderId — json columns cannot be filtered. */
  order_id?: string | null;
  /** Branch attribution frozen at creation — see StoreSnapshot. */
  store_snapshot?: StoreSnapshot | null;
  status: TicketStatus;
  priority: Priority;
  assigned_agent: string | null;
  assigned_team: string | null;
  conversation: string | null;
  /** Branch the complaint is about (`stores` id), when one was recorded. */
  store?: string | null;
  contact: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_responded_at: string | null;
  /** When the ticket was solved. Written by "Mark as solved". */
  resolved_at?: string | null;
  /**
   * Directus stamps these on every write, so the ticket carries its own last
   * edit without us keeping a second history alongside `ticket_events`.
   */
  date_updated?: string | null;
  user_updated?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
  attachments?: TicketAttachment[];
  date_created: string | null;
}

export interface TicketEvent {
  id: string;
  event_type: string;
  actor: { id: string; email: string | null; first_name: string | null } | string | null;
  payload: Record<string, unknown> | null;
  date_created: string | null;
}

export function useTickets() {
  return useQuery({
    queryKey: ['tickets'],
    queryFn: () =>
      directus.request(
        readItems('tickets', {
          limit: -1,
          fields: [
            'id',
            'subject',
            'description',
            'status',
            'priority',
            'assigned_agent',
            'assigned_team',
            'conversation',
            'first_response_due_at',
            'resolution_due_at',
            'first_responded_at',
            'date_created',
            // The list is scanned by category the way the ops team scan their
            // own sheet, so the type rides along with the summary read.
            'complaint_type',
            { contact: ['id', 'name', 'email', 'phone'] },
          ],
          sort: ['-date_created'],
        }),
      ) as Promise<TicketRow[]>,
  });
}

export function useTicket(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: ['ticket', id],
    queryFn: async () => {
      const rows = (await directus.request(
        readItems('tickets', {
          filter: { id: { _eq: id } },
          fields: [
            'id',
            'subject',
            'description',
            'status',
            'priority',
            'assigned_agent',
            'assigned_team',
            'conversation',
            'first_response_due_at',
            'resolution_due_at',
            'first_responded_at',
            'resolved_at',
            'date_created',
            'date_updated',
            'order_snapshot',
            'store',
            ...COMPLAINT_FIELDS,
            // Expanded, not the bare id: "changed by 3f2a…" names nobody a
            // supervisor could follow up with.
            { user_updated: ['id', 'first_name', 'last_name', 'email'] },
            { contact: ['id', 'name', 'email', 'phone'] },
            {
              attachments: ['id', { directus_files_id: ['id', 'filename_download', 'type'] }],
            },
          ],
          limit: 1,
        }),
      )) as Array<Record<string, unknown>>;
      const raw = rows[0];
      if (!raw) return null;
      // Flatten the junction rows into a friendlier shape.
      const attachments = (
        (raw.attachments as Array<Record<string, unknown>> | undefined) ?? []
      ).map((j) => {
        const f = j.directus_files_id as {
          id: string;
          filename_download: string | null;
          type: string | null;
        } | null;
        return {
          id: j.id as string,
          file: f ? { id: f.id, filename: f.filename_download, type: f.type } : null,
        };
      });
      return { ...(raw as unknown as TicketRow), attachments };
    },
  });
}

export function useTicketEvents(ticketId: string | null) {
  return useQuery({
    enabled: !!ticketId,
    queryKey: ['ticket-events', ticketId],
    queryFn: () =>
      directus.request(
        readItems('ticket_events', {
          filter: { ticket: { _eq: ticketId } },
          fields: [
            'id',
            'event_type',
            'payload',
            'date_created',
            { actor: ['id', 'email', 'first_name'] },
          ],
          sort: ['date_created'],
          limit: -1,
        }),
      ) as Promise<TicketEvent[]>,
  });
}

export interface CreateTicketInput extends Partial<TicketComplaintFields> {
  subject: string;
  description?: string;
  priority: Priority;
  contact: string;
  vendor: string;
  conversation?: string | null;
  assigned_agent?: string | null;
  /** Structured point-in-time copy of the order the ticket is about. */
  order_snapshot?: TicketOrderSnapshot | null;
  /** Searchable copy of order_snapshot.orderId — json columns cannot be filtered. */
  order_id?: string | null;
  /**
   * Which branch, as a live link — what reports group by, and what an agent
   * corrects when the order resolved to the wrong place.
   */
  store?: string | null;
  /**
   * What that branch WAS at creation: name, brand, city, both managers, and how
   * it was matched. Frozen, because resolving live means one edit to a store
   * rewrites every past report. See StoreSnapshot.
   */
  store_snapshot?: StoreSnapshot | null;
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTicketInput) =>
      directus.request(createItem('tickets', { ...input, status: 'new' } as never)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      // The conversation sidebar's linked-tickets list keys on
      // ['linked-tickets', conversationId]; refresh it so a ticket created
      // from a conversation shows up there without a remount.
      void qc.invalidateQueries({ queryKey: ['linked-tickets'] });
    },
  });
}

/**
 * File ids attached to a conversation's OWN messages — i.e. every file shared in
 * THIS chat session (not the customer's earlier conversations). Used when a
 * ticket is spun out of a chat so the session's attachments ride along onto it.
 *
 * Fail-soft: against an older gateway/permission set the junction read may be
 * denied — we return `[]` so the ticket still creates (just without the copied
 * files) rather than blocking creation.
 */
export function useConversationAttachmentIds(conversationId: string | null) {
  return useQuery({
    enabled: !!conversationId,
    queryKey: ['conversation-attachment-ids', conversationId],
    queryFn: async () => {
      try {
        const msgs = (await directus.request(
          readItems('messages', {
            filter: { conversation: { _eq: conversationId } },
            fields: ['id'],
            limit: -1,
          }),
        )) as Array<{ id: string }>;
        const ids = msgs.map((m) => m.id);
        if (ids.length === 0) return [] as string[];
        const links = (await directus.request(
          readItems('messages_files', {
            filter: { messages_id: { _in: ids } },
            fields: [{ directus_files_id: ['id'] }],
            limit: -1,
          }),
        )) as Array<{ directus_files_id: { id: string } | null }>;
        // Dedupe: the same file could be linked to more than one message.
        const seen = new Set<string>();
        for (const l of links) if (l.directus_files_id?.id) seen.add(l.directus_files_id.id);
        return [...seen];
      } catch {
        return [] as string[];
      }
    },
  });
}

export interface CreateTicketFromConversationInput {
  ticket: CreateTicketInput;
  /** File ids from the chat session to copy onto the new ticket (see FR #3). */
  attachmentFileIds?: string[];
  /**
   * The complaint types operations has decided the BRANCH should hear about.
   * Passed in rather than read here so the decision is taken against the rules
   * the agent's form was actually showing.
   */
  storeNotifyTypes?: readonly string[];
}

/** What happened to the branch notification for a ticket that was just saved. */
export type StoreNotifyOutcome = 'queued' | 'failed' | StoreNotificationSkip;

/**
 * The complaint types that notify the branch, as a plain list.
 *
 * Read-only for agents: which types are the branch's business is an operations
 * decision made in the admin console. Fail-soft — if the rules cannot be read,
 * the list is empty and nothing is queued, which is the safe direction: a
 * missing notification is recoverable, a wrong one has already been sent.
 */
export function useStoreNotifyTypes() {
  return useQuery({
    queryKey: ['store-notify-types'],
    staleTime: 60_000,
    queryFn: async () => {
      try {
        const rows = (await directus.request(
          readItems(
            'store_notify_rules' as never,
            {
              filter: { enabled: { _eq: true } },
              fields: ['complaint_type'],
              limit: -1,
            } as never,
          ),
        )) as unknown as Array<{ complaint_type: string | null }>;
        return rows.map((r) => r.complaint_type).filter((v): v is string => !!v);
      } catch {
        return [] as string[];
      }
    },
  });
}

/**
 * Create a ticket out of a chat and carry the session's context onto it: the
 * ticket is linked to the conversation (via `ticket.conversation`), and every
 * file shared in that chat is linked into `tickets_files`. Attachment linking is
 * best-effort (`Promise.allSettled`) so one bad file id never discards the
 * ticket that was already created.
 *
 * The order travels as structured JSON on `ticket.order_snapshot`, and the
 * complaint columns ride along on the same insert, so the ticket is complete
 * the moment it exists rather than needing a follow-up PATCH.
 */
export function useCreateTicketFromConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ticket,
      attachmentFileIds,
      storeNotifyTypes,
    }: CreateTicketFromConversationInput) => {
      const created = (await directus.request(
        createItem('tickets', { ...ticket, status: 'new' } as never),
      )) as { id: string };
      if (attachmentFileIds && attachmentFileIds.length > 0) {
        await Promise.allSettled(
          attachmentFileIds.map((fid) =>
            directus.request(
              createItem('tickets_files', {
                tickets_id: created.id,
                directus_files_id: fid,
              } as never),
            ),
          ),
        );
      }

      // Tell the branch — but only for the complaint types operations chose,
      // and only what they need: the description and the resolution notes.
      const decision = storeNotificationDraft(
        {
          ticketId: created.id,
          storeId: ticket.store ?? null,
          complaintType: ticket.complaint_type ?? null,
          description: ticket.description ?? null,
          resolutionNotes: ticket.response_desc ?? null,
          // WHICH order, and what was on it. A branch told "an item was
          // missing" with no order number has to ask us back, which is the
          // round trip this notification exists to remove.
          orderId: ticket.order_id ?? null,
          orderItems:
            ticket.order_snapshot?.items?.map((i) => ({
              name: i.name,
              qty: i.qty,
              price: i.price,
            })) ?? null,
        },
        storeNotifyTypes ?? [],
      );
      let storeNotify: StoreNotifyOutcome = 'skip' in decision ? decision.skip : 'queued';
      if ('draft' in decision) {
        try {
          await directus.request(createItem('store_notifications' as never, decision.draft));
        } catch {
          // The ticket is saved and must stay saved. A queue entry that could
          // not be written is reported back so the agent is told the branch
          // was NOT informed, rather than left assuming it was.
          storeNotify = 'failed';
        }
      }
      return { ...created, storeNotify };
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      void qc.invalidateQueries({ queryKey: ['linked-tickets'] });
      if (created?.id) void qc.invalidateQueries({ queryKey: ['ticket', created.id] });
    },
  });
}

export interface UpdateTicketInput extends Partial<TicketComplaintFields> {
  store?: string | null;
  status?: TicketStatus;
  priority?: Priority;
  assigned_agent?: string | null;
  assigned_team?: string | null;
  first_responded_at?: string;
  resolved_at?: string;
  closed_at?: string;
}

export function useUpdateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateTicketInput }) =>
      directus.request(updateItem('tickets', id, patch as never)),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      void qc.invalidateQueries({ queryKey: ['ticket', vars.id] });
      void qc.invalidateQueries({ queryKey: ['ticket-events', vars.id] });
      // The assignment persisted — now tell the assignee (in-app + email per
      // their preferences, via the workers' notifications processor). Only when
      // this patch actually set an agent; unassignment (null) notifies nobody.
      // Best-effort by design: notifyAssignmentBestEffort never throws, so a
      // producer/Redis outage cannot fail or roll back the assignment.
      if (typeof vars.patch.assigned_agent === 'string' && vars.patch.assigned_agent) {
        notifyAssignmentBestEffort('ticket', vars.id);
      }
    },
  });
}

/**
 * Add an internal note to a ticket as an append-only 'commented' event. Mentions
 * (resolved agent ids) ride along in the payload for downstream notification.
 */
/**
 * Stamp "this agent opened WhatsApp for this customer" onto the ticket.
 *
 * The stamp IS the feature: wa.me opens a chat but records nobody. Written as
 * a `contacted` ticket event so it lands in the same history panel as every
 * other touch, with the actor attached.
 */
export function useStampContacted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      actorId,
      phone,
    }: {
      ticketId: string;
      actorId: string;
      phone: string;
    }) =>
      directus.request(
        createItem('ticket_events', {
          ticket: ticketId,
          event_type: 'contacted',
          actor: actorId,
          payload: { channel: 'whatsapp', phone },
        } as never),
      ),
    onSuccess: (_d, vars) =>
      void qc.invalidateQueries({ queryKey: ['ticket-events', vars.ticketId] }),
  });
}

export function useAddTicketNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      text,
      actorId,
      mentions,
    }: {
      ticketId: string;
      text: string;
      actorId: string;
      mentions?: string[];
    }) =>
      directus.request(
        createItem('ticket_events', {
          ticket: ticketId,
          event_type: 'commented',
          actor: actorId,
          payload: { text, ...(mentions && mentions.length ? { mentions } : {}) },
        } as never),
      ),
    onSuccess: (_d, vars) =>
      void qc.invalidateQueries({ queryKey: ['ticket-events', vars.ticketId] }),
  });
}

/** Upload a file and link it to a ticket via the tickets_files junction. */
export function useAddTicketAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ticketId, file }: { ticketId: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      const uploaded = (await directus.request(uploadFiles(fd))) as { id: string };
      await directus.request(
        createItem('tickets_files', {
          tickets_id: ticketId,
          directus_files_id: uploaded.id,
        } as never),
      );
    },
    onSuccess: (_d, vars) => void qc.invalidateQueries({ queryKey: ['ticket', vars.ticketId] }),
  });
}

/** Remove a ticket attachment by its junction-row id. */
export function useRemoveTicketAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ junctionId }: { junctionId: string; ticketId: string }) =>
      directus.request(deleteItem('tickets_files', junctionId)),
    onSuccess: (_d, vars) => void qc.invalidateQueries({ queryKey: ['ticket', vars.ticketId] }),
  });
}

/** A file shared in the ticket's linked chat, re-usable as a ticket attachment. */
export interface ChatAttachment {
  /** Directus file id (already uploaded via the chat). */
  id: string;
  filename: string | null;
  type: string | null;
  filesize: number | null;
  sender_type: 'customer' | 'agent' | 'system' | null;
  date_created: string | null;
}

/**
 * Every file shared in a conversation's chat (the messages_files junction),
 * newest first and de-duplicated by file. Lets an agent attach a file the
 * customer already sent in chat onto an EXISTING ticket without re-uploading it
 * — the "add it later if it wasn't carried over at creation" path (complements
 * useConversationAttachmentIds, which copies files at create time). Fails soft
 * (returns []) if the junction read is denied by an older permission set.
 */
/**
 * Can the signed-in agent actually read this conversation?
 *
 * A ticket is scoped to the agent it is assigned to; a conversation is scoped
 * separately (own / unassigned / own team). Those can disagree — the usual way
 * is a chat handed to another shift while the ticket stays with whoever raised
 * it. Directus answers a filtered read with 200 and an empty list, not a 403,
 * so anything reading the chat's messages gets `[]` and cannot tell "there is
 * nothing" from "this is not yours to see".
 *
 * One cheap id lookup gives the caller that distinction, so a panel can say
 * which of the two it is instead of quietly asserting the friendlier one.
 */
export function useCanReadConversation(conversationId: string | null) {
  return useQuery({
    enabled: !!conversationId,
    queryKey: ['can-read-conversation', conversationId],
    staleTime: 60_000,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems('conversations', {
          filter: { id: { _eq: conversationId } },
          fields: ['id'],
          limit: 1,
        }),
      )) as Array<{ id: string }>;
      return rows.length > 0;
    },
  });
}

export function useConversationAttachments(conversationId: string | null) {
  return useQuery({
    enabled: !!conversationId,
    queryKey: ['conversation-attachments', conversationId],
    queryFn: async (): Promise<ChatAttachment[]> => {
      try {
        const links = (await directus.request(
          readItems('messages_files', {
            filter: { messages_id: { conversation: { _eq: conversationId } } },
            fields: [
              { messages_id: ['sender_type', 'date_created'] },
              { directus_files_id: ['id', 'filename_download', 'type', 'filesize'] },
            ],
            limit: -1,
          }),
        )) as Array<{
          messages_id: {
            sender_type: ChatAttachment['sender_type'];
            date_created: string | null;
          } | null;
          directus_files_id: {
            id: string;
            filename_download: string | null;
            type: string | null;
            filesize: number | string | null;
          } | null;
        }>;
        // De-dupe by file id (a file can be linked to more than one message).
        const byFile = new Map<string, ChatAttachment>();
        for (const l of links) {
          const f = l.directus_files_id;
          if (!f || byFile.has(f.id)) continue;
          const fs = f.filesize;
          byFile.set(f.id, {
            id: f.id,
            filename: f.filename_download,
            type: f.type,
            filesize: fs === null || fs === undefined ? null : Number(fs),
            sender_type: l.messages_id?.sender_type ?? null,
            date_created: l.messages_id?.date_created ?? null,
          });
        }
        return Array.from(byFile.values()).sort((a, b) => {
          const x = a.date_created ?? '';
          const y = b.date_created ?? '';
          return x < y ? 1 : x > y ? -1 : 0;
        });
      } catch {
        return [];
      }
    },
  });
}

/**
 * Link an existing Directus file (e.g. one shared in chat) to a ticket via the
 * tickets_files junction — no upload, the file already exists in Directus.
 */
export function useAttachExistingFileToTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, fileId }: { ticketId: string; fileId: string }) =>
      directus.request(
        createItem('tickets_files', {
          tickets_id: ticketId,
          directus_files_id: fileId,
        } as never),
      ),
    onSuccess: (_d, vars) => void qc.invalidateQueries({ queryKey: ['ticket', vars.ticketId] }),
  });
}
