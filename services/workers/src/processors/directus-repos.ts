import { readItems, updateItem, createItem, readUser, readUsers } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import type {
  NotificationsRepo,
  SlaPolicyRow,
  TeamRepo,
  TicketEventRow,
  TicketEventType,
  TicketRepo,
  TicketRow,
} from './repos.js';

/** Real (Directus-backed) implementations of the processor repos. */

export function createTicketRepo(client: YijiDirectusClient): TicketRepo {
  return {
    async listOpenTickets() {
      return (await client.request(
        readItems('tickets', {
          filter: { status: { _in: ['new', 'open', 'pending'] } },
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
            'first_response_minutes',
            'resolution_minutes',
            'warning_threshold_percent',
            'business_hours',
            'active',
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
     * Only active users with an app role are candidates — a suspended account
     * is not somebody to hand a customer to.
     */
    async agentsByLoad(teamId: string | null) {
      const users = (await client.request(
        readUsers({
          filter: {
            status: { _eq: 'active' },
            ...(teamId ? { team: { _eq: teamId } } : {}),
          },
          fields: ['id'],
          limit: -1,
        }) as never,
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
     * Agent replies only. An inbound customer message must NOT cancel an
     * escalation — a customer chasing an unanswered chat would otherwise reset
     * the very timer meant to rescue them.
     */
    async countOutboundMessages(conversationId: string) {
      const rows = (await client.request(
        readItems('messages' as never, {
          filter: {
            conversation: { _eq: conversationId },
            sender_type: { _eq: 'agent' },
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
