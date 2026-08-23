/**
 * Repository interfaces extracted so processors can be unit-tested without
 * a live Directus. The real (Directus-backed) implementations live in
 * `directus-repos.ts`; tests pass in-memory stubs.
 */
import type { Priority, SlaPolicyScope } from '@yiji/shared-types';

export interface TicketRow {
  id: string;
  status: 'new' | 'open' | 'pending' | 'resolved' | 'closed';
  priority: Priority;
  sla_policy: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_responded_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  assigned_agent: string | null;
  assigned_team: string | null;
  date_created: string | null;
  /* The three facts an SLA policy may narrow by, beyond priority. Read on the
   * reconcile sweep because that is where a policy gets attached; a ticket
   * that carries none of them still matches a priority-only policy. */
  complaint_type?: string | null;
  complaint_source?: string | null;
  /* Frozen store attribution — `brandName` is the half the SLA matcher reads.
   * The snapshot, not a live join: an SLA is a promise made when the ticket was
   * raised, so moving a branch to another brand today must not retroactively
   * change which promise last month's tickets were held to. */
  store_snapshot?: { brandName?: string | null } | null;
}

export interface SlaPolicyRow extends SlaPolicyScope {
  id: string;
  name: string;
  applies_to_priority: Priority[];
  first_response_minutes: number;
  resolution_minutes: number;
  warning_threshold_percent: number;
  business_hours: import('../lib/sla-clock.js').BusinessHours | null;
  active: boolean;
}

export type TicketEventType =
  | 'created'
  | 'status_changed'
  | 'assigned'
  | 'commented'
  | 'sla_warning'
  | 'sla_breached'
  | 'sla_escalated'
  | 'resolved'
  | 'closed'
  | 'reopened'
  | 'automation_triggered';

export interface TicketEventRow {
  id?: string;
  event_type: TicketEventType;
  payload: Record<string, unknown> | null;
}

export interface TicketRepo {
  listOpenTickets(): Promise<TicketRow[]>;
  listActiveSlaPolicies(): Promise<SlaPolicyRow[]>;
  getTicket(id: string): Promise<TicketRow | null>;
  patchTicket(id: string, patch: Partial<TicketRow>): Promise<void>;
  createTicketEvent(
    ticketId: string,
    type: TicketEventType,
    payload?: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Read back a ticket's audit trail, optionally narrowed to one event type.
   * `ticket_events` is append-only, which makes it the durable idempotency
   * ledger for at-least-once queue jobs (see sla.ts runBreach).
   */
  listTicketEvents(ticketId: string, type?: TicketEventType): Promise<TicketEventRow[]>;
}

export interface TeamRepo {
  /**
   * User ids belonging to a team (`directus_users.team` is a FK to `teams`).
   *
   * Escalation fans out to individual users rather than writing one row against
   * a team, because `notifications.recipient` is a user FK by design: read
   * state, the per-user channel preferences in `getUserPreferences`, the email
   * address in `getUserEmail`, and the gateway's push to a personal socket room
   * are ALL keyed on a user. A team-addressed row would have no owner for any
   * of them. "Notify the team" therefore means N per-user notifications.
   */
  listMemberIds(teamId: string): Promise<string[]>;
}

export interface NotificationsRepo {
  /** Notification preferences map: type → channel. */
  getUserPreferences(userId: string): Promise<Record<string, string>>;
  /** Resolve a user's email address (null if unknown) for email delivery. */
  getUserEmail(userId: string): Promise<string | null>;
  /** Persist an in-app notifications row + stamp delivery timestamps. */
  createNotification(input: {
    recipient: string;
    type: string;
    title: string;
    body: string;
    link?: string;
    payload?: Record<string, unknown>;
    channelInappDeliveredAt?: string;
    channelEmailDeliveredAt?: string;
  }): Promise<{ id: string }>;
  /** Stamp channel_email_delivered_at AFTER a successful send (never at creation). */
  markEmailDelivered(id: string): Promise<void>;
}
