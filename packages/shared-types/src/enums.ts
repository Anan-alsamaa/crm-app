import { z } from 'zod';

/** Shared enums used across collections, services, and portals (single source of truth). */

export const Locale = z.enum(['en', 'ar']);
export type Locale = z.infer<typeof Locale>;

export const VendorStatus = z.enum(['active', 'inactive']);
export type VendorStatus = z.infer<typeof VendorStatus>;

/**
 * A chat is either being worked or it is finished. Two states, deliberately.
 *
 * It used to carry four (`pending`, `resolved`, `closed` as well) and agents
 * had to decide between three shades of "not open" that no report distinguished
 * anyway. Retired values are migrated, not merely dropped from this list:
 * `pending` -> `open`, and `resolved`/`closed` -> `solved`. Narrowing the enum
 * alone would leave rows holding a value no filter matches, so those chats
 * would vanish from the inbox rather than error.
 *
 * TICKET status is separate and still has its own five; do not unify them.
 */
export const ConversationStatus = z.enum(['open', 'solved']);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

/** What each retired chat status becomes. Used by the migration and by readers
 *  of historical rows that predate it. */
export const RETIRED_CONVERSATION_STATUS: Record<string, ConversationStatus> = {
  pending: 'open',
  resolved: 'solved',
  closed: 'solved',
};

/** Normalise any stored chat status, including the retired ones. */
export function normaliseConversationStatus(raw: string | null | undefined): ConversationStatus {
  if (raw === 'open' || raw === 'solved') return raw;
  return RETIRED_CONVERSATION_STATUS[raw ?? ''] ?? 'open';
}

export const TicketStatus = z.enum(['new', 'open', 'pending', 'resolved', 'closed']);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const Priority = z.enum(['low', 'medium', 'high', 'urgent']);
export type Priority = z.infer<typeof Priority>;

export const SenderType = z.enum(['customer', 'agent', 'system']);
export type SenderType = z.infer<typeof SenderType>;

/* ── Complaint vocabulary ────────────────────────────────────────────────────
 *
 * The operations team's own dropdown lists, taken VERBATIM from their complaint
 * app (`Ayman/dropdown_options.json`), which derived them from 1,673 real
 * complaints logged Jan–Jul 2026.
 *
 * The spellings are theirs — "Comp. Twiter", "Comp.Instgram", "Dinning",
 * "Instore preparation late order". Do NOT "fix" them: these strings are the
 * stored values in the history that gets imported, and correcting one here
 * silently splits a category in two across the old and new rows. The typos are
 * data, not a bug. Where a value reads badly on screen it is given a clean
 * display label in the portal's i18n bundle, leaving the stored value alone.
 */

export const ComplaintType = z.enum([
  'Accuracy',
  'Cleanness',
  'Driver attitude',
  'Foreign object found',
  'Hospitality',
  'Instore preparation late order',
  'Late order',
  'Missing condiments',
  'Missing item',
  'Order cold',
  'Order Late in store',
  'Product',
  'Roach found',
  'Technical issue',
]);
export type ComplaintType = z.infer<typeof ComplaintType>;

/** How the order was fulfilled. */
export const ServiceType = z.enum(['Delivery', 'Dinning', 'Drive Thru', 'Pickup', 'TakeOut']);
export type ServiceType = z.infer<typeof ServiceType>;

/** Where the complaint came in from. */
export const ComplaintSource = z.enum([
  'Comp. Phone Call',
  'Comp. Twiter',
  'Comp. WhatsApp',
  'Comp.Instgram',
  'WeCare Channels',
]);
export type ComplaintSource = z.infer<typeof ComplaintSource>;

/**
 * How the agent talked to the customer about it. Overlaps ComplaintSource by
 * design — the two are separate columns in their sheet because a complaint that
 * arrives on Twitter is routinely answered on WhatsApp, and they report on both.
 */
export const CommunicationMethod = z.enum([
  // 'CRM' is ours, not theirs. Their list has no entry for it because their tool
  // has no chat of its own — every reply left through some other channel. In
  // this system the agent answers inside the CRM, so a ticket raised from a
  // conversation is answered on 'CRM' and says so. The rest of the list stays:
  // an agent who phones the customer back must still be able to record that.
  'CRM',
  'AFCO APP',
  'Comp. Phone Call',
  'Comp. Twiter',
  'Comp. WhatsApp',
  'Comp.Instgram',
]);

/** What a ticket raised from a CRM conversation was answered on. */
export const DEFAULT_COMMUNICATION_METHOD: CommunicationMethod = 'CRM';
export type CommunicationMethod = z.infer<typeof CommunicationMethod>;

/** Whether the customer was compensated. "Initial" = not decided yet. */
export const Compensation = z.enum(['Initial', 'Compensated', 'Not Compensated']);
export type Compensation = z.infer<typeof Compensation>;

export const TicketEventType = z.enum([
  'created',
  'status_changed',
  'assigned',
  'commented',
  'sla_warning',
  'sla_breached',
  'sla_escalated',
  'resolved',
  'closed',
  'reopened',
  'automation_triggered',
]);
export type TicketEventType = z.infer<typeof TicketEventType>;

export const NotificationType = z.enum([
  'sla_warning',
  'sla_breach',
  'assignment',
  'mention',
  'ticket_update',
  'reminder',
  'escalation',
  'automation',
]);
export type NotificationType = z.infer<typeof NotificationType>;

export const NotificationChannel = z.enum(['in_app', 'email', 'both', 'none']);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const AutomationTrigger = z.enum([
  'conversation_created',
  'message_received',
  'ticket_created',
  'ticket_status_changed',
  'sla_warning',
  'sla_breach',
  'inactivity',
  'keyword_matched',
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const AutomationActionType = z.enum([
  'assign_agent',
  'assign_team',
  'set_priority',
  'add_tag',
  'send_notification',
  'escalate',
  'set_status',
]);
export type AutomationActionType = z.infer<typeof AutomationActionType>;

export const ReportType = z.enum([
  'conversation_volume',
  'response_time',
  'sla_compliance',
  'ticket_resolution',
  'agent_productivity',
  'csat',
  'vendor_activity',
]);
export type ReportType = z.infer<typeof ReportType>;

export const CustomFieldEntity = z.enum(['contact', 'conversation', 'ticket']);
export type CustomFieldEntity = z.infer<typeof CustomFieldEntity>;

export const CustomFieldType = z.enum([
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multiselect',
]);
export type CustomFieldType = z.infer<typeof CustomFieldType>;
