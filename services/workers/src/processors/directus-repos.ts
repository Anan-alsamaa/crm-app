import { readItems, updateItem, createItem, readUser, readUsers, readRoles } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  HUMAN_AGENT_MESSAGE_FILTER,
  roleNamesHolding,
  UNSOLVED_TICKET_STATUSES_STORED,
  type Privilege,
} from '@yiji/shared-types';
import type {
  ConversationRepo,
  ConversationRow,
  NotificationsRepo,
  SlaPolicyRow,
  TeamRepo,
  TicketEventRow,
  TicketEventType,
  TicketRepo,
  TicketRow,
} from './repos.js';

/**
 * Roles a customer chat may be routed to.
 *
 * Everything else — the three svc-* accounts and Administrator — is active,
 * holds zero conversations forever, and would otherwise sort to the front of
 * every least-loaded list. See agentsByLoad.
 *
 * `WeCare Agent` and `WeCare Supervisor` are the customer-facing roles (owner,
 * 2026-09-14): a supervisor works the queue alongside their team, so a chat may
 * be routed to them. `WeCare Admin` and `Administrator` are NOT routable no
 * matter how idle they look — being signed in is not the same as being on the
 * floor.
 *
 * A supervisor therefore appears in BOTH this list and `SUPERVISOR_ROLES`
 * below, which is intended: they can be handed a chat, and they are told when a
 * chat runs out of agents. Being alerted about one they now own is noise worth
 * accepting next to a chat nobody is offered at all.
 *
 * It briefly also listed `Agent`, because the deployed model used `WeCare
 * Agent` while this list said `Agent` — the filter matched nobody and
 * auto-assignment had nobody to assign to, which reads as a plausible empty
 * roster rather than a fault. The legacy `Agent`, `Admin` and `Supervisor`
 * roles were removed from both environments on 2026-09-13 (no user held any of
 * them), so naming `Agent` here would now describe a role that does not exist.
 */
const ROUTABLE_ROLES = ['WeCare Agent', 'WeCare Supervisor'] as const;

/**
 * Who is told when a chat runs out of agents to offer it to.
 *
 * BY ROLE, AND MORE THAN ONE ROLE, counted against the real database. A
 * previous "notify the admins" reached NOBODY because it selected by privilege
 * and the builtin roles carry none — and production today has ZERO `WeCare
 * Supervisor` accounts, so naming that role alone would repeat the bug exactly.
 * `WeCare Admin` (2 active) and `Administrator` (1) are who actually exists, so
 * they are listed too and the alert has a real recipient.
 */
const SUPERVISOR_ROLES = ['WeCare Supervisor', 'WeCare Admin', 'Administrator'] as const;

/**
 * The role NAMES whose role holds `key` — the Roles page's `receive_chats` and
 * `no_agents_alert` since 2026-10-06 (owner). The two lists above are their
 * DEFAULTS, and what is used whenever the roles cannot be read (the service
 * account needs read on app_roles), so a failed read routes exactly as before.
 */
export async function roleNamesWith(
  client: YijiDirectusClient,
  key: Privilege,
  fallback: readonly string[],
): Promise<string[]> {
  try {
    const [roles, appRoles] = await Promise.all([
      client.request(readRoles({ fields: ['name'], limit: -1 }) as never) as Promise<
        Array<{ name: string }>
      >,
      client.request(
        readItems('app_roles' as never, { fields: ['name', 'privileges'], limit: -1 }) as never,
      ) as Promise<Array<{ name: string; privileges: unknown }>>,
    ]);
    // Possibly EMPTY: the owner may have switched it off for every role.
    return roleNamesHolding(
      key,
      roles.map((r) => r.name),
      appRoles,
    );
  } catch {
    return [...fallback];
  }
}

/** Real (Directus-backed) implementations of the processor repos. */

export function createTicketRepo(client: YijiDirectusClient): TicketRepo {
  return {
    async listOpenTickets() {
      return (await client.request(
        readItems('tickets', {
          /* `pending` is the live unfinished state (owner, 2026-10-07); `open`
             and `new` are kept so rows stored before it still match. */
          filter: { status: { _in: [...UNSOLVED_TICKET_STATUSES_STORED] } },
          fields: [
            'id',
            'status',
            'priority',
            'sla_policy',
            'first_response_due_at',
            'resolution_due_at',
            'first_responded_at',
            'resolved_at',
            'closed_at',
            'assigned_agent',
            'assigned_team',
            'date_created',
            /* The coverage facts. A policy may narrow by any of them, so the
             * sweep cannot decide which policy governs a ticket without
             * reading them — before this, every policy was matched on
             * priority alone because priority was all the sweep could see. */
            'complaint_type',
            'complaint_source',
            'store_snapshot',
          ],
          limit: -1,
        }),
      )) as TicketRow[];
    },
    async listActiveSlaPolicies() {
      return (await client.request(
        readItems('sla_policies', {
          filter: { active: { _eq: true } },
          fields: [
            'id',
            'name',
            'applies_to_priority',
            'applies_to_type',
            'applies_to_source',
            'applies_to_brand',
            'governs',
            'first_response_minutes',
            'resolution_minutes',
            'warning_threshold_percent',
            'business_hours',
            'active',
            'date_created',
          ],
          limit: -1,
        }),
      )) as SlaPolicyRow[];
    },
    async getTicket(id: string) {
      const rows = (await client.request(
        readItems('tickets', {
          filter: { id: { _eq: id } },
          fields: [
            'id',
            'status',
            'priority',
            'sla_policy',
            'first_response_due_at',
            'resolution_due_at',
            'first_responded_at',
            'resolved_at',
            'closed_at',
            'assigned_agent',
            'assigned_team',
            'date_created',
          ],
          limit: 1,
        }),
      )) as TicketRow[];
      return rows[0] ?? null;
    },
    async patchTicket(id, patch) {
      await client.request(updateItem('tickets', id, patch as never));
    },
    async createTicketEvent(ticketId: string, type: TicketEventType, payload) {
      await client.request(
        createItem('ticket_events', {
          ticket: ticketId,
          event_type: type,
          payload: payload ?? null,
        } as never),
      );
    },
    async listTicketEvents(ticketId: string, type?: TicketEventType) {
      return (await client.request(
        readItems('ticket_events', {
          filter: type
            ? { _and: [{ ticket: { _eq: ticketId } }, { event_type: { _eq: type } }] }
            : { ticket: { _eq: ticketId } },
          fields: ['id', 'event_type', 'payload'],
          sort: ['-id'],
          limit: 100,
        }),
      )) as TicketEventRow[];
    },
  };
}

/**
 * Chats with a live first-response promise.
 *
 * Filtered in the QUERY, not in JS: an answered chat can never breach, and a
 * solved one is finished, so pulling the whole inbox back to discard most of it
 * would make the sweep's cost grow with history rather than with the work
 * actually outstanding. Retired status values are matched alongside `open`
 * because rows written before the status migration still carry them.
 */
export function createConversationRepo(client: YijiDirectusClient): ConversationRepo {
  return {
    async listUnansweredConversations() {
      return (await client.request(
        readItems('conversations', {
          filter: {
            status: { _in: ['open', 'pending'] },
            first_responded_at: { _null: true },
            archived_at: { _null: true },
            /*
             * AN AGENT-INITIATED CHAT HAS NOBODY WAITING FOR AN ANSWER.
             *
             * The first-response promise is "a customer wrote to us and we
             * will reply within N minutes". A chat the AGENT opened inverts
             * that: the only message is ours, so `first_responded_at` is null
             * for the whole life of the chat and this sweep would start a
             * clock, let it expire and record a BREACH against an agent who
             * did nothing wrong — in fact against the one who made the first
             * move. Every outbound chat would arrive pre-broken.
             *
             * `_neq` rather than `_eq: 'customer'` on purpose: every row that
             * existed before this field did has it NULL, and `_eq` would
             * silently drop all of them out of the sweep — the
             * [[silent-empty-failures]] shape, where a filter that matches
             * nothing reads as a clean zero.
             */
            initiated_by: { _neq: 'agent' },
          },
          fields: [
            'id',
            'status',
            'priority',
            'first_response_due_at',
            'first_responded_at',
            'first_response_breached_at',
            'assigned_agent',
            'assigned_team',
            'date_created',
            /* The clock's zero for a REOPENED chat — see ConversationRow. A
               field the sweep reads but never SELECTS is always undefined, so
               it would silently fall back to `date_created` and breach every
               reopened chat on sight. */
            'session_started_at',
          ],
          limit: -1,
        }),
      )) as ConversationRow[];
    },
    async patchConversation(id, patch) {
      await client.request(updateItem('conversations', id, patch as never));
    },
  };
}

export function createTeamRepo(client: YijiDirectusClient): TeamRepo {
  return {
    async listMemberIds(teamId: string) {
      // `status` filter: suspended/archived accounts must not be paged. Draft and
      // invited users have never signed in, so they'd get an in-app row nobody
      // reads plus an email to an unconfirmed address.
      const rows = (await client.request(
        readUsers({
          filter: { team: { _eq: teamId }, status: { _eq: 'active' } },
          fields: ['id'],
          limit: -1,
        }),
      )) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    },
  };
}

export function createNotificationsRepo(client: YijiDirectusClient): NotificationsRepo {
  return {
    async getUserPreferences(userId: string) {
      try {
        const u = (await client.request(
          readUser(userId, { fields: ['notification_preferences'] }),
        )) as { notification_preferences?: Record<string, string> | null };
        return u.notification_preferences ?? {};
      } catch {
        return {};
      }
    },
    async getUserEmail(userId: string) {
      try {
        const u = (await client.request(readUser(userId, { fields: ['email'] }))) as {
          email?: string | null;
        };
        return u.email ?? null;
      } catch {
        return null;
      }
    },
    async createNotification(input) {
      const row = (await client.request(
        createItem('notifications', {
          recipient: input.recipient,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          payload: input.payload ?? null,
          channel_inapp_delivered_at: input.channelInappDeliveredAt ?? null,
          channel_email_delivered_at: input.channelEmailDeliveredAt ?? null,
        } as never),
      )) as { id: string };
      return { id: row.id };
    },
    async markEmailDelivered(id) {
      await client.request(
        updateItem('notifications', id, {
          channel_email_delivered_at: new Date().toISOString(),
        } as never),
      );
    },
  };
}

/**
 * Directus access for the auto-assignment ladder.
 *
 * Deliberately narrow: three calls, no caching. Routing decisions must read the
 * CURRENT assignee and reply count, because the whole point of the escalation
 * timers is to notice a change that happened while they were pending.
 */
export function createRoutingRepo(client: YijiDirectusClient) {
  return {
    async getConversation(id: string) {
      const rows = (await client.request(
        readItems('conversations' as never, {
          filter: { id: { _eq: id } },
          // The team scopes who may be offered the chat, so the ladder has to
          // read it with the assignee, not separately.
          fields: ['id', 'assigned_agent', 'assigned_team', 'status'],
          limit: 1,
        }) as never,
      )) as Array<{
        id: string;
        assigned_agent: string | null;
        assigned_team: string | null;
        status: string;
      }>;
      return rows[0] ?? null;
    },

    /**
     * Eligible agents, least busy first.
     *
     * "Busy" is their count of OPEN conversations, counted here rather than
     * kept as a column: a counter that has to be maintained on every assign,
     * solve and reopen is a counter that drifts, and the ladder runs rarely
     * enough that one aggregate query is cheaper than that risk.
     *
     * Only active users in a CUSTOMER-FACING role are candidates. A suspended
     * account is not somebody to hand a customer to — and neither is a service
     * account or the Administrator.
     *
     * That last part was the whole bug. This filtered on `status` alone, and
     * svc-socket-gateway, svc-workers, svc-ai-gateway and Administrator are all
     * active and permanently hold zero conversations, so they sorted to the
     * FRONT of a least-loaded list and won every out-of-hours assignment. The
     * chat was then worse than unowned: `assigned_agent` is not null, so the
     * unassigned safety net skips it, and the portal filters service accounts
     * out of its agent list, so the toolbar renders "Agent —". The record says
     * somebody owns it and the screen says nobody does.
     *
     * An ALLOW-list of roles, not a deny-list of emails: a new service account
     * must not be able to join the customer rotation by being named something
     * the deny-list did not anticipate. The portal's own display filter
     * (apps/agent-portal/src/features/inbox/api.ts) is the mirror of this.
     */
    async agentsByLoad(teamId: string | null) {
      // Cast: the SDK types model `role` as a scalar on directus_users, so a
      // relational clause on it does not typecheck even though Directus serves
      // `filter[role][name][_in]` perfectly well.
      const routable = await roleNamesWith(client, 'receive_chats', ROUTABLE_ROLES);
      if (routable.length === 0) return [];
      const filter = {
        status: { _eq: 'active' },
        role: { name: { _in: routable } },
        ...(teamId ? { team: { _eq: teamId } } : {}),
      } as never;
      const users = (await client.request(
        readUsers({ filter, fields: ['id'], limit: -1 }) as never,
      )) as Array<{ id: string }>;
      const ids = users.map((u) => u.id);
      if (ids.length === 0) return [];

      const open = (await client.request(
        readItems('conversations' as never, {
          filter: { status: { _eq: 'open' }, assigned_agent: { _in: ids } },
          fields: ['assigned_agent'],
          limit: -1,
        }) as never,
      )) as Array<{ assigned_agent: string | null }>;

      const load = new Map<string, number>(ids.map((id) => [id, 0]));
      for (const c of open) {
        if (c.assigned_agent) load.set(c.assigned_agent, (load.get(c.assigned_agent) ?? 0) + 1);
      }
      // Ties broken by id so the order is stable: an unstable order makes the
      // fallback non-deterministic and the tests flaky for no benefit.
      return ids.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b));
    },

    /**
     * Active users who should hear that a chat has run out of agents.
     *
     * Same allow-list shape as `agentsByLoad`: naming roles, never excluding
     * emails, so a new service account cannot join the alert list by accident.
     */
    async supervisorIds(): Promise<string[]> {
      const alerted = await roleNamesWith(client, 'no_agents_alert', SUPERVISOR_ROLES);
      if (alerted.length === 0) return [];
      const filter = {
        status: { _eq: 'active' },
        role: { name: { _in: alerted } },
      } as never;
      const users = (await client.request(
        readUsers({ filter, fields: ['id'], limit: -1 }) as never,
      )) as Array<{ id: string }>;
      return users.map((u) => u.id);
    },

    /**
     * Agent replies only. An inbound customer message must NOT cancel an
     * escalation — a customer chasing an unanswered chat would otherwise reset
     * the very timer meant to rescue them.
     *
     * HUMAN replies only (owner, 2026-10-06): the automatic welcome is an
     * agent-style message with no `sender_user`, sent a second after the
     * customer's first message. Counted, it would look like "an agent replied"
     * and cancel the escalation of a chat no person has touched — the ladder
     * standing down exactly when it is needed.
     */
    async countOutboundMessages(conversationId: string) {
      const rows = (await client.request(
        readItems('messages' as never, {
          filter: {
            conversation: { _eq: conversationId },
            ...HUMAN_AGENT_MESSAGE_FILTER,
          },
          aggregate: { count: 'id' },
        }) as never,
      )) as Array<{ count: { id: number | string } }>;
      return Number(rows[0]?.count?.id ?? 0);
    },

    async recordOutcome(row: {
      conversationId: string;
      agentId: string;
      outcome: 'answered' | 'missed';
      stage: string;
      secondsHeld: number;
    }) {
      await client.request(
        createItem(
          'routing_events' as never,
          {
            conversation: row.conversationId,
            agent: row.agentId,
            outcome: row.outcome,
            stage: row.stage,
            seconds_held: row.secondsHeld,
          } as never,
        ) as never,
      );
    },

    async assign(conversationId: string, agentId: string) {
      await client.request(
        updateItem(
          'conversations' as never,
          conversationId as never,
          {
            assigned_agent: agentId,
          } as never,
        ) as never,
      );
    },
  };
}
