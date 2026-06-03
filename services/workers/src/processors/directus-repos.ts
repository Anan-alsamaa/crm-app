import { readItems, updateItem, createItem, readUser } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import type {
  NotificationsRepo,
  SlaPolicyRow,
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
  };
}
