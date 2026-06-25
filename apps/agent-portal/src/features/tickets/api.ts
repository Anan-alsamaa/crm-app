import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem, uploadFiles } from '@directus/sdk';
import type { Priority, TicketStatus } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

export interface TicketAttachment {
  /** Junction-row id (for removal). */
  id: string;
  file: { id: string; filename: string | null; type: string | null } | null;
}

export interface TicketRow {
  id: string;
  subject: string;
  description: string | null;
  status: TicketStatus;
  priority: Priority;
  assigned_agent: string | null;
  assigned_team: string | null;
  conversation: string | null;
  contact: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_responded_at: string | null;
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
            'date_created',
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

export interface CreateTicketInput {
  subject: string;
  description?: string;
  priority: Priority;
  contact: string;
  vendor: string;
  conversation?: string | null;
  assigned_agent?: string | null;
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

export interface UpdateTicketInput {
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
    },
  });
}

/**
 * Add an internal note to a ticket as an append-only 'commented' event. Mentions
 * (resolved agent ids) ride along in the payload for downstream notification.
 */
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
