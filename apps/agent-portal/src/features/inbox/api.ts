import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, readUsers, updateItem, createItem } from '@directus/sdk';
import type { ConversationStatus, Priority } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

export interface InboxConversation {
  id: string;
  status: ConversationStatus;
  priority: Priority;
  last_message_at: string | null;
  unread_count_agent: number;
  assigned_agent: string | null;
  assigned_team: string | null;
  contact: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  tags?: Array<{ tags_id: { id: string; name: string; color: string | null } | null }>;
}

export interface ConversationMessage {
  id: string;
  sender_type: 'customer' | 'agent' | 'system';
  content: string;
  is_internal_note: boolean;
  date_created: string | null;
}

export interface InboxFilters {
  status?: ConversationStatus | 'all';
  priority?: Priority | 'all';
  search?: string;
  sort?: 'recent' | 'oldest' | 'priority';
}

function buildFilter(f: InboxFilters): Record<string, unknown> | undefined {
  const and: Array<Record<string, unknown>> = [];
  if (f.status && f.status !== 'all') and.push({ status: { _eq: f.status } });
  if (f.priority && f.priority !== 'all') and.push({ priority: { _eq: f.priority } });
  if (f.search?.trim()) {
    const s = f.search.trim();
    and.push({
      _or: [
        { contact: { name: { _icontains: s } } },
        { contact: { email: { _icontains: s } } },
        { contact: { phone: { _icontains: s } } },
      ],
    });
  }
  return and.length ? { _and: and } : undefined;
}

function buildSort(f: InboxFilters): string[] {
  if (f.sort === 'oldest') return ['last_message_at'];
  if (f.sort === 'priority') return ['priority', '-last_message_at'];
  return ['-last_message_at'];
}

export function useConversations(filters: InboxFilters = {}) {
  const filter = buildFilter(filters);
  const sort = buildSort(filters);
  return useQuery({
    queryKey: ['conversations', filters],
    queryFn: () =>
      directus.request(
        readItems('conversations', {
          limit: -1,
          fields: [
            'id',
            'status',
            'priority',
            'last_message_at',
            'unread_count_agent',
            'assigned_agent',
            'assigned_team',
            { contact: ['id', 'name', 'email', 'phone'] },
            { tags: [{ tags_id: ['id', 'name', 'color'] }] },
          ],
          sort,
          ...(filter ? { filter } : {}),
        }),
      ) as Promise<InboxConversation[]>,
  });
}

export function useMessages(conversationId: string | null) {
  return useQuery({
    enabled: !!conversationId,
    queryKey: ['messages', conversationId],
    queryFn: () =>
      directus.request(
        readItems('messages', {
          filter: { conversation: { _eq: conversationId } },
          fields: ['id', 'sender_type', 'content', 'is_internal_note', 'date_created'],
          sort: ['date_created'],
          limit: -1,
        }),
      ) as Promise<ConversationMessage[]>,
  });
}

/** Single conversation with full detail for the sidebar. */
export function useConversation(conversationId: string | null) {
  return useQuery({
    enabled: !!conversationId,
    queryKey: ['conversation', conversationId],
    queryFn: () =>
      directus
        .request(
          readItems('conversations', {
            filter: { id: { _eq: conversationId } },
            fields: [
              'id',
              'status',
              'priority',
              'assigned_agent',
              'assigned_team',
              { contact: ['id', 'name', 'email', 'phone'] },
              { vendor: ['id', 'name'] },
              { tags: [{ tags_id: ['id', 'name', 'color'] }] },
            ],
            limit: 1,
          }),
        )
        .then((rows) => (rows as InboxConversation[])[0] ?? null),
  });
}

export interface ConversationPatch {
  status?: ConversationStatus;
  priority?: Priority;
  assigned_agent?: string | null;
  assigned_team?: string | null;
}

export function useUpdateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ConversationPatch }) =>
      directus.request(updateItem('conversations', id, patch as never)),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['conversation', vars.id] });
    },
  });
}

/** Linked tickets for the conversation sidebar. */
export interface LinkedTicket {
  id: string;
  subject: string;
  status: string;
  priority: string;
}
export function useLinkedTickets(conversationId: string | null) {
  return useQuery({
    enabled: !!conversationId,
    queryKey: ['linked-tickets', conversationId],
    queryFn: () =>
      directus.request(
        readItems('tickets', {
          filter: { conversation: { _eq: conversationId } },
          fields: ['id', 'subject', 'status', 'priority'],
          sort: ['-date_created'],
          limit: -1,
        }),
      ) as Promise<LinkedTicket[]>,
  });
}

// ----- Agents/teams (for assignment + @mentions) -----
export interface AgentOption {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}
export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () =>
      directus.request(
        readUsers({
          limit: -1,
          fields: ['id', 'email', 'first_name', 'last_name'],
          sort: ['email'],
        }),
      ) as Promise<AgentOption[]>,
  });
}

export interface TeamOption {
  id: string;
  name: string;
}
export function useTeamOptions() {
  return useQuery({
    queryKey: ['teams-options'],
    queryFn: () =>
      directus.request(
        readItems('teams', { limit: -1, fields: ['id', 'name'], sort: ['name'] }),
      ) as Promise<TeamOption[]>,
  });
}

// ----- Tags -----
export interface Tag {
  id: string;
  name: string;
  color: string | null;
}
export function useTags() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: () =>
      directus.request(
        readItems('tags', { limit: -1, fields: ['id', 'name', 'color'], sort: ['name'] }),
      ) as Promise<Tag[]>,
  });
}

export function useAddTagToConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, tagId }: { conversationId: string; tagId: string }) =>
      directus.request(
        createItem('conversations_tags', {
          conversations_id: conversationId,
          tags_id: tagId,
        } as never),
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['conversation', vars.conversationId] });
    },
  });
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, color }: { name: string; color?: string }) =>
      directus.request(createItem('tags', { name, color: color ?? '#94a3b8' } as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }),
  });
}
