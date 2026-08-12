import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, readUsers, updateItem, createItem, deleteItem } from '@directus/sdk';
import type { ConversationStatus, Priority } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { notifyAssignmentBestEffort } from '../../lib/job-producer.js';

export interface InboxConversation {
  id: string;
  status: ConversationStatus;
  priority: Priority;
  last_message_at: string | null;
  unread_count_agent: number;
  assigned_agent: string | null;
  assigned_team: string | null;
  contact: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  /**
   * Expanded by `useConversation`, absent from the list query. Directus returns
   * a bare id string when the relation is not expanded, hence the union — read
   * it through `conversationVendorId` rather than reaching in.
   */
  vendor?: { id: string; name?: string | null } | string | null;
  tags?: Array<{ id: string; tags_id: { id: string; name: string; color: string | null } | null }>;
}

/** The vendor id, whether the relation came back expanded or as a bare id. */
export function conversationVendorId(c: InboxConversation | null | undefined): string {
  const v = c?.vendor;
  if (!v) return '';
  return typeof v === 'string' ? v : (v.id ?? '');
}

export interface MessageAttachment {
  id: string;
  filename: string | null;
  type: string | null;
  filesize: number | null;
}

export interface ConversationMessage {
  id: string;
  sender_type: 'customer' | 'agent' | 'system';
  content: string;
  is_internal_note: boolean;
  date_created: string | null;
  attachments?: MessageAttachment[];
  /** Client-only: an optimistic message awaiting the server echo. */
  pending?: boolean;
}

export interface InboxFilters {
  status?: ConversationStatus | 'all';
  priority?: Priority | 'all';
  search?: string;
  /**
   * Conversation ids whose ticket is about an order matching the search term,
   * resolved by conversationIdsForOrder(). Kept out of `search` because it is
   * the ANSWER to a second query, not another field to match on.
   */
  orderConversationIds?: string[];
  sort?: 'recent' | 'oldest' | 'priority';
  /**
   * Whose conversations to show.
   *   'mine'  — assigned to me, plus the unassigned pool. The working view for
   *             an agent once auto-assignment is on: without it every agent
   *             still sees every chat and the assignment means nothing.
   *   'all'   — everything, whoever it belongs to. For a manager who needs to
   *             find a conversation another agent handled.
   * Undefined behaves as 'all', which keeps existing callers unchanged.
   */
  assignment?: 'mine' | 'all';
  /** Required when assignment === 'mine'. */
  currentUserId?: string;
}

function buildFilter(f: InboxFilters): Record<string, unknown> | undefined {
  const and: Array<Record<string, unknown>> = [];
  if (f.status && f.status !== 'all') and.push({ status: { _eq: f.status } });
  if (f.priority && f.priority !== 'all') and.push({ priority: { _eq: f.priority } });
  if (f.assignment === 'mine' && f.currentUserId) {
    // Mine OR nobody's. The unassigned half matters: it is where the escalation
    // ladder drops a conversation nobody picked up, and an agent who could not
    // see those would never rescue one.
    and.push({
      _or: [{ assigned_agent: { _eq: f.currentUserId } }, { assigned_agent: { _null: true } }],
    });
  }
  if (f.search?.trim()) {
    const s = f.search.trim();
    const or: Array<Record<string, unknown>> = [
      { contact: { name: { _icontains: s } } },
      { contact: { email: { _icontains: s } } },
      { contact: { phone: { _icontains: s } } },
    ];
    // Order id. A conversation carries no order, so this arrives already
    // resolved to conversation ids by `conversationIdsForOrder` — see there for
    // why it cannot be expressed as a filter on this collection.
    if (f.orderConversationIds && f.orderConversationIds.length > 0) {
      or.push({ id: { _in: f.orderConversationIds } });
    }
    and.push({ _or: or });
  }
  return and.length ? { _and: and } : undefined;
}

/**
 * Conversations that have a ticket about an order matching `term`.
 *
 * Two queries rather than one, because the order lives on the TICKET and the
 * inbox lists CONVERSATIONS. Directus cannot reach across that relation from
 * the conversation side without a defined o2m, and it cannot filter inside
 * `order_snapshot` at all (a json column rejects `_contains` outright), which
 * is why tickets carry the id in a real indexed `order_id` column.
 *
 * A term with no digits is not an order id, so it skips the round trip
 * entirely — otherwise every keystroke of a customer's name would query
 * tickets for nothing.
 *
 * KNOWN LIMIT: agents can only read tickets assigned to them (roles.ts scopes
 * `tickets.read` to `assigned_agent = $CURRENT_USER`). So an agent searching an
 * order handled by a COLLEAGUE finds nothing, even when the conversation itself
 * is visible to them. Widening that is a permission decision, not a search fix.
 */
export async function conversationIdsForOrder(term: string): Promise<string[]> {
  const s = term.trim();
  if (!/\d/.test(s)) return [];
  const rows = (await directus.request(
    readItems('tickets', {
      filter: { order_id: { _contains: s }, conversation: { _nnull: true } },
      fields: ['conversation'],
      limit: 200,
    }),
  )) as Array<{ conversation: string | null }>;
  return Array.from(new Set(rows.map((r) => r.conversation).filter((c): c is string => !!c)));
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
            { tags: ['id', { tags_id: ['id', 'name', 'color'] }] },
          ],
          sort,
          ...(filter ? { filter } : {}),
        }),
      ) as Promise<InboxConversation[]>,
  });
}

/** Last-message preview for a conversation row (WhatsApp-style subtitle). */
export interface ConversationPreview {
  content: string;
  sender_type: 'customer' | 'agent' | 'system';
  hasAttachment: boolean;
}

/**
 * The latest real message (not an internal note) for each conversation in
 * `conversationIds`, keyed by conversation id — used as the WhatsApp-style
 * second line in the inbox list. One batched query, reduced to first-per-
 * conversation (sorted newest-first). Fails soft to {} so rows still render.
 */
export function useConversationPreviews(conversationIds: string[]) {
  // Stable key regardless of order so re-sorts don't refetch.
  const key = [...conversationIds].sort().join(',');
  return useQuery({
    enabled: conversationIds.length > 0,
    queryKey: ['conversation-previews', key],
    staleTime: 10_000,
    queryFn: async (): Promise<Record<string, ConversationPreview>> => {
      try {
        const rows = (await directus.request(
          readItems('messages', {
            filter: {
              conversation: { _in: conversationIds },
              is_internal_note: { _eq: false },
            },
            fields: ['conversation', 'content', 'sender_type'],
            sort: ['-date_created'],
            // Generous cap: the inbox shows a bounded list; the newest message
            // per conversation is comfortably within this window at app scale.
            limit: 1000,
          }),
        )) as Array<{
          conversation: string;
          content: string | null;
          sender_type: ConversationPreview['sender_type'];
        }>;
        const byConv: Record<string, ConversationPreview> = {};
        for (const r of rows) {
          if (!r.conversation || byConv[r.conversation]) continue; // first = latest
          const content = (r.content ?? '').trim();
          byConv[r.conversation] = {
            content,
            sender_type: r.sender_type,
            hasAttachment: content.length === 0,
          };
        }
        return byConv;
      } catch {
        return {};
      }
    },
  });
}

export function useMessages(conversationId: string | null) {
  return useQuery({
    enabled: !!conversationId,
    queryKey: ['messages', conversationId],
    queryFn: async () => {
      const msgs = (await directus.request(
        readItems('messages', {
          filter: { conversation: { _eq: conversationId } },
          fields: ['id', 'sender_type', 'content', 'is_internal_note', 'date_created'],
          sort: ['date_created'],
          limit: -1,
        }),
      )) as ConversationMessage[];
      const ids = msgs.map((m) => m.id);
      if (ids.length === 0) return msgs;
      // Attachments live in the messages_files m2m junction (there is no alias
      // field on `messages`). Fail soft: against an older gateway/permission set
      // the junction read may be denied — messages still render without chips.
      try {
        const links = (await directus.request(
          readItems('messages_files', {
            filter: { messages_id: { _in: ids } },
            fields: [
              'messages_id',
              { directus_files_id: ['id', 'filename_download', 'type', 'filesize'] },
            ],
            limit: -1,
          }),
        )) as Array<{
          messages_id: string;
          directus_files_id: {
            id: string;
            filename_download: string | null;
            type: string | null;
            filesize: number | string | null;
          } | null;
        }>;
        const byMsg = new Map<string, MessageAttachment[]>();
        for (const l of links) {
          if (!l.directus_files_id) continue;
          const arr = byMsg.get(l.messages_id) ?? [];
          const fs = l.directus_files_id.filesize;
          arr.push({
            id: l.directus_files_id.id,
            filename: l.directus_files_id.filename_download,
            type: l.directus_files_id.type,
            filesize: fs === null || fs === undefined ? null : Number(fs),
          });
          byMsg.set(l.messages_id, arr);
        }
        for (const m of msgs) {
          const a = byMsg.get(m.id);
          if (a) m.attachments = a;
        }
      } catch {
        /* attachments unavailable — render messages without them */
      }
      return msgs;
    },
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
              { tags: ['id', { tags_id: ['id', 'name', 'color'] }] },
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
      // The assignment persisted — now tell the assignee (in-app + email per
      // their preferences, via the workers' notifications processor). Only when
      // this patch actually set an agent; unassignment (null) notifies nobody.
      // Best-effort by design: notifyAssignmentBestEffort never throws, so a
      // producer/Redis outage cannot fail or roll back the assignment.
      if (typeof vars.patch.assigned_agent === 'string' && vars.patch.assigned_agent) {
        notifyAssignmentBestEffort('conversation', vars.id);
      }
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
      directus
        .request(
          readUsers({
            limit: -1,
            fields: ['id', 'email', 'first_name', 'last_name'],
            sort: ['email'],
          }),
        )
        // Service accounts (svc-*@svc.example.com) aren't people — never offer
        // them for assignment or @mentions.
        .then((rows) =>
          (rows as AgentOption[]).filter((u) => !(u.email ?? '').toLowerCase().includes('@svc.')),
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

export function useRemoveTagFromConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ junctionId }: { junctionId: string; conversationId: string }) =>
      directus.request(deleteItem('conversations_tags', junctionId)),
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
      directus.request(
        createItem('tags', { name, color: color ?? '#94a3b8' } as never),
      ) as Promise<{ id: string; name: string; color: string | null }>,
    onSuccess: (created) => {
      // Seed the new tag into the cached list immediately so it is reusable on
      // the spot — across conversations, without waiting for the refetch — then
      // invalidate to reconcile with the DB. (Tags persist globally already;
      // this just removes the brief window where a fresh tag isn't yet listed.)
      qc.setQueryData<Tag[]>(['tags'], (prev) => {
        const list = prev ?? [];
        if (list.some((tg) => tg.id === created.id)) return list;
        return [...list, { id: created.id, name: created.name, color: created.color }].sort(
          (a, b) => a.name.localeCompare(b.name),
        );
      });
      void qc.invalidateQueries({ queryKey: ['tags'] });
    },
  });
}

/**
 * Delete a tag from the library entirely. The conversations_tags / contacts_tags /
 * tickets_tags junctions are ON DELETE CASCADE, so the tag is removed from every
 * conversation, contact and ticket it was on — a global, irreversible action.
 * (Requires the Agent role's `tags: delete` permission.)
 */
export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('tags', id)),
    onSuccess: (_d, id) => {
      qc.setQueryData<Tag[]>(['tags'], (prev) => (prev ?? []).filter((tg) => tg.id !== id));
      void qc.invalidateQueries({ queryKey: ['tags'] });
      // The tag cascades out of every junction — refresh anything that renders tags.
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      void qc.invalidateQueries({ queryKey: ['contact'] });
    },
  });
}
