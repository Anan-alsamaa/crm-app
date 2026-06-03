/**
 * Repository interfaces extracted so processors can be unit-tested without
 * a live Directus. The real (Directus-backed) implementations live in
 * `directus-repos.ts`; tests pass in-memory stubs.
 */
import type { Priority } from '@yiji/shared-types';

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
}

export interface SlaPolicyRow {
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
  | 'resolved'
  | 'closed'
  | 'reopened'
  | 'automation_triggered';

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
}

export interface NotificationsRepo {
  /** Notification preferences map: type → channel. */
  getUserPreferences(userId: string): Promise<Record<string, string>>;
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
}
