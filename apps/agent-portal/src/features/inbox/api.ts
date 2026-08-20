import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, readUsers, updateItem, createItem, deleteItem } from '@directus/sdk';
import type { ConversationStatus, Priority, YijiOrder } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';
import { jobProducer, notifyAssignmentBestEffort } from '../../lib/job-producer.js';

export interface InboxConversation {
  id: string;
  status: ConversationStatus;
  priority: Priority;
  last_message_at: string | null;
  unread_count_agent: number;
  assigned_agent: string | null;
  assigned_team: string | null;
  contact: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    /** Present on the LIST read only, so a row can prefetch its orders on hover. */
    external_customer_id?: string | null;
    vendor?: { id: string; yiji_vendor_id: string | null } | null;
  } | null;
  /**
   * Expanded by `useConversation`, absent from the list query. Directus returns
   * a bare id string when the relation is not expanded, hence the union — read
   * it through `conversationVendorId` rather than reaching in.
   */
  vendor?: { id: string; name?: string | null } | string | null;
  tags?: Array<{ id: string; tags_id: { id: string; name: string; color: string | null } | null }>;
  /**
   * The order this chat was last seen to be about. Stamped by the order panel;
   * used to paint that panel instantly on the next open, and — the reason it is
   * a column rather than a cache — to make the inbox searchable by order id.
   */
  last_order_id?: string | null;
  last_order_snapshot?: YijiOrder | null;
  last_order_at?: string | null;
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
  content: string | null;
  is_internal_note: boolean;
  date_created: string | null;
  attachments?: MessageAttachment[];
  /** Client-only: an optimistic message awaiting the server echo. */
  pending?: boolean;
}

export interface InboxFilters {
  status?: ConversationStatus | 'all';
  priority?: Priority | 'all';
  /** Only chats with messages the agent has not read yet. */
  unread?: boolean;
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
  /** The viewer's team, so a shift handover lands in their working view too. */
  currentTeamId?: string | null;
}

function buildFilter(f: InboxFilters): Record<string, unknown> | undefined {
  const and: Array<Record<string, unknown>> = [];
  /**
   * Archived chats are out of the inbox, including under "all conversations" —
   * "all" means everything still being worked, not everything that ever
   * happened. Unconditional rather than a filter option, because a switch that
   * reveals them would make the working set unbounded again, which is the one
   * thing archiving exists to prevent. They are still reachable by id, so a
   * link into an old chat keeps working, and archiving is reversible.
   */
  and.push({ archived_at: { _null: true } });
  if (f.status && f.status !== 'all') and.push({ status: { _eq: f.status } });
  if (f.priority && f.priority !== 'all') and.push({ priority: { _eq: f.priority } });
  // Same column the unread TILE counts, so clicking it lands on exactly the
  // chats it was counting — a tile whose filter disagrees with its own number
  // is worse than a tile that does nothing.
  if (f.unread) and.push({ unread_count_agent: { _gt: 0 } });
  if (f.assignment === 'mine' && f.currentUserId) {
    // Mine, nobody's, or MY TEAM's.
    //
    // The unassigned half is a safety net rather than a workflow now — routing
    // always leaves an owner — but it stays so a chat that somehow lost one is
    // still rescuable rather than invisible.
    //
    // The team half is the shift handover: a chat passed to my team has to
    // appear in my working view, not only in "all conversations", or the
    // handover has moved a label and nothing else.
    const or: Array<Record<string, unknown>> = [
      { assigned_agent: { _eq: f.currentUserId } },
      { assigned_agent: { _null: true } },
    ];
    if (f.currentTeamId) or.push({ assigned_team: { _eq: f.currentTeamId } });
    and.push({ _or: or });
  }
  if (f.search?.trim()) {
    const s = f.search.trim();
    const or: Array<Record<string, unknown>> = [
      { contact: { name: { _icontains: s } } },
      { contact: { email: { _icontains: s } } },
      { contact: { phone: { _icontains: s } } },
    ];
    // THE order-id search. `last_order_id` is stamped on the conversation the
    // first time its order panel resolves, which is what makes this one indexed
    // column match instead of a join nobody can express — and unlike the ticket
    // route below it works before any ticket exists, which is the common case:
    // the agent is searching for the chat in order to raise one.
    if (/\d/.test(s)) or.push({ last_order_id: { _contains: s } });
    // Also match via a TICKET raised about that order — see
    // `conversationIdsForOrder`. Kept alongside rather than replaced: it finds
    // chats worked before stamping existed, and complaints logged by phone.
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

/**
 * React Query key for the inbox order panel, shared so the inbox list can
 * PREFETCH a conversation's orders under the exact key the panel will read.
 */
export function inboxOrdersKey(vendorId: string, customerId: string | undefined) {
  return ['yiji-inbox-orders', vendorId, customerId] as const;
}

/**
 * The agent on `teamId` currently holding the fewest OPEN conversations.
 *
 * Used by the shift handover: assigning a team without also giving the chat an
 * owner leaves it with whoever has it now, which for a night-to-day handover is
 * exactly the person logging off.
 *
 * Least-loaded rather than random because a handover happens in bulk at the end
 * of a shift — a random pick would land a whole night's backlog on whichever
 * agent the shuffle favoured. Counted live: a maintained counter is a counter
 * that drifts, and this runs once per handover.
 *
 * Returns null when the team has nobody in it. That is a real state (a team
 * created but not staffed yet), and the caller says so rather than silently
 * doing nothing.
 */
export async function leastLoadedAgentInTeam(teamId: string): Promise<string | null> {
  /**
   * Ask the GATEWAY first — it holds a service token and can actually see the
   * loads. This client-side count runs through the agent's own session, and the
   * Agent role cannot read a colleague's conversations, so it measures every
   * teammate as zero and the tie-break hands the whole backlog to the lowest
   * uuid. Reproduced twice against the live system: it picked an agent already
   * holding 2 (then 3) open chats over one holding none.
   *
   * The local path below survives only as a fallback for a gateway outage, and
   * it now refuses to pretend: an all-zero map over a non-empty roster means
   * "not measurable", not "everyone is idle".
   */
  try {
    return await jobProducer.leastLoadedAgentInTeam(teamId);
  } catch {
    /* fall through to the local estimate */
  }

  const users = (await directus.request(
    readUsers({
      filter: { team: { _eq: teamId }, status: { _eq: 'active' } },
      fields: ['id'],
      limit: -1,
    }),
  )) as unknown as Array<{ id: string }>;
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return null;

  const open = (await directus.request(
    readItems('conversations', {
      filter: { status: { _eq: 'open' }, assigned_agent: { _in: ids } },
      fields: ['assigned_agent'],
      limit: -1,
    }),
  )) as unknown as Array<{ assigned_agent: string | null }>;

  const load = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const c of open) {
    if (c.assigned_agent) load.set(c.assigned_agent, (load.get(c.assigned_agent) ?? 0) + 1);
  }
  /**
   * Every teammate at zero, over a team that has people in it, is what a
   * permission-blinded read looks like — not a genuinely idle shift. Returning
   * a pick from that data is worse than returning nothing: the caller believes
   * it balanced the work. Null makes the toolbar say the team could not be
   * measured instead.
   */
  if ([...load.values()].every((n) => n === 0) && open.length === 0) return null;

  // Ties broken by id so two agents doing the same handover at once do not
  // both pick "whoever the sort happened to put first this time".
  return [...ids].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b))[0]!;
}

/**
 * Warm a conversation's order panel before the agent opens it.
 *
 * An agent moves the pointer to a row a beat before clicking it, and that beat
 * is longer than the whole commerce call once the gateway's cache is warm. By
 * the time the panel mounts the answer is already in the query cache, so it
 * paints on the first frame rather than after a round trip.
 *
 * Safe to fire on every hover: `prefetchQuery` is a no-op for data that is
 * still fresh, so sweeping the pointer down the list does not fan out.
 */
export function usePrefetchInboxOrders() {
  const qc = useQueryClient();
  return useCallback(
    (c: InboxConversation) => {
      const vendorId = c.contact?.vendor?.yiji_vendor_id ?? '';
      const customerId = c.contact?.external_customer_id ?? '';
      if (!vendorId || !customerId) return;
      void qc.prefetchQuery({
        queryKey: inboxOrdersKey(vendorId, customerId),
        queryFn: () => commerce.getInboxOrders(vendorId, customerId, { limit: 2 }),
        staleTime: 60_000,
      });
    },
    [qc],
  );
}

/**
 * Record the order this chat is about onto the conversation itself.
 *
 * Called once per conversation per session, after the commerce panel resolves.
 * Best-effort in every direction: a failure is swallowed (the agent is working
 * a chat, not maintaining an index), and it is skipped entirely when the stored
 * id already matches, so opening the same chat repeatedly is not a write.
 *
 * The gateway deliberately does NOT do this — Directus stays the sole writer,
 * and using the agent's own token means a chat can only be stamped by someone
 * who can already see it.
 */
export function useStampConversationOrder() {
  const stamped = useRef(new Map<string, string>());
  return useCallback((conversationId: string, order: YijiOrder) => {
    const orderId = String(order.orderId);
    if (!conversationId || !orderId) return;
    if (stamped.current.get(conversationId) === orderId) return;
    stamped.current.set(conversationId, orderId);
    void directus
      .request(
        updateItem('conversations', conversationId, {
          last_order_id: orderId,
          last_order_snapshot: order,
          last_order_at: new Date().toISOString(),
        } as never),
      )
      .catch(() => {
        // Let it be retried on the next open rather than leaving a lie behind.
        stamped.current.delete(conversationId);
      });
  }, []);
}

function buildSort(f: InboxFilters): string[] {
  if (f.sort === 'oldest') return ['last_message_at'];
  if (f.sort === 'priority') return ['priority', '-last_message_at'];
  return ['-last_message_at'];
}

/**
 * The three numbers above the list: open, urgent, unread.
 *
 * They describe the INBOX, not the current view — which is the whole point of
 * the fix. They used to be counted from the already-filtered list, so clicking
 * "urgent" filtered the list, recounted over the result, and reported 0 open /
 * 0 urgent / 0 unread. Every tile read zero, the numbers no longer meant
 * anything, and because the invisible priority filter stayed on, typing in the
 * search box returned nothing too — the reported "search stops working".
 *
 * Scope follows the ASSIGNMENT choice (my queue vs all conversations), because
 * the tiles are a glance at the work you are looking at. It deliberately
 * ignores status, priority and search: those are what the tiles toggle, and a
 * counter that reacts to its own filter can never be clicked back.
 */
export function useInboxCounts(
  scope: Pick<InboxFilters, 'assignment' | 'currentUserId' | 'currentTeamId'> = {},
) {
  // Only the scope matters — a status/priority/search change must not refetch
  // these, or the numbers would flicker as the agent filters.
  const base = buildFilter({
    assignment: scope.assignment,
    currentUserId: scope.currentUserId,
    currentTeamId: scope.currentTeamId,
  });
  const withBase = (extra: Record<string, unknown>) => ({
    _and: [...(base ? [base] : []), extra],
  });

  return useQuery({
    queryKey: ['inbox-counts', scope.assignment ?? 'all', scope.currentUserId, scope.currentTeamId],
    staleTime: 15_000,
    queryFn: async () => {
      // Three aggregates rather than one fetch of every row: the count must
      // stay honest on an inbox far larger than any page of it.
      const count = async (extra: Record<string, unknown>): Promise<number> => {
        const res = (await directus.request(
          readItems('conversations', {
            aggregate: { count: 'id' },
            filter: withBase(extra),
          } as never),
        )) as unknown as Array<{ count: { id: number | string } | number | string }>;
        const raw = res?.[0]?.count;
        const n =
          typeof raw === 'object' && raw !== null ? (raw as { id: number | string }).id : raw;
        return Number(n ?? 0);
      };
      const [open, urgent, unread] = await Promise.all([
        count({ status: { _eq: 'open' } }),
        count({ priority: { _eq: 'urgent' } }),
        count({ unread_count_agent: { _gt: 0 } }),
      ]);
      return { open, urgent, unread };
    },
  });
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
            // The two ids a row needs to PREFETCH its orders on hover. Fetched
            // with the list because asking for them per row would be the
            // request storm the prefetch exists to avoid.
            {
              contact: [
                'id',
                'name',
                'email',
                'phone',
                'external_customer_id',
                { vendor: ['id', 'yiji_vendor_id'] },
              ],
            },
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
              // Paints the order panel before the commerce call has started.
              'last_order_id',
              'last_order_snapshot',
              'last_order_at',
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
  /** Stamped when a chat is marked solved, cleared when it is reopened. */
  solved_at?: string | null;
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
  /** Carried so callers can pick the LATEST without trusting query order. */
  date_created: string | null;
}
export function useLinkedTickets(conversationId: string | null) {
  return useQuery({
    enabled: !!conversationId,
    queryKey: ['linked-tickets', conversationId],
    queryFn: () =>
      directus.request(
        readItems('tickets', {
          filter: { conversation: { _eq: conversationId } },
          fields: ['id', 'subject', 'status', 'priority', 'date_created'],
          sort: ['-date_created'],
          // Only the newest few, by request: a long-standing customer can have
          // dozens of tickets, and the sidebar is for what is CURRENT — the
          // full history stays reachable from the tickets page and reports.
          limit: 3,
        }),
      ) as Promise<LinkedTicket[]>,
  });
}

/** One earlier conversation with the same customer. */
export interface PastConversation {
  id: string;
  status: string;
  date_created: string | null;
  last_message_at: string | null;
  assigned_agent: string | null;
}

/**
 * Everything this customer has talked to us about before.
 *
 * The operations manager's ask: a returning customer routed to a different
 * agent used to arrive with no history, so the new agent made them repeat a
 * story the company already had. Excludes the conversation being viewed —
 * that one is on screen.
 */
export function useCustomerHistory(contactId: string | null, excludeId: string | null) {
  return useQuery({
    enabled: !!contactId,
    queryKey: ['customer-history', contactId, excludeId],
    queryFn: async () => {
      const rows = (await directus.request(
        readItems('conversations', {
          filter: { contact: { _eq: contactId } },
          fields: ['id', 'status', 'date_created', 'last_message_at', 'assigned_agent'],
          sort: ['-last_message_at'],
          limit: 25,
        }),
      )) as unknown as PastConversation[];
      return rows.filter((r) => r.id !== excludeId);
    },
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
