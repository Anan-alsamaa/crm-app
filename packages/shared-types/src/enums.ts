import { z } from 'zod';

/** Shared enums used across collections, services, and portals (single source of truth). */

export const Locale = z.enum(['en', 'ar']);
export type Locale = z.infer<typeof Locale>;

export const VendorStatus = z.enum(['active', 'inactive']);
export type VendorStatus = z.infer<typeof VendorStatus>;

export const ConversationStatus = z.enum(['open', 'pending', 'resolved', 'closed']);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const TicketStatus = z.enum(['new', 'open', 'pending', 'resolved', 'closed']);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const Priority = z.enum(['low', 'medium', 'high', 'urgent']);
export type Priority = z.infer<typeof Priority>;

export const SenderType = z.enum(['customer', 'agent', 'system']);
export type SenderType = z.infer<typeof SenderType>;

export const TicketEventType = z.enum([
  'created',
  'status_changed',
  'assigned',
  'commented',
  'sla_warning',
  'sla_breached',
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
