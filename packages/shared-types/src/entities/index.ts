import { z } from 'zod';
import { directusDefaults, Id } from './common.js';
import {
  AutomationActionType,
  AutomationTrigger,
  ConversationStatus,
  CustomFieldEntity,
  CustomFieldType,
  Locale,
  NotificationChannel,
  NotificationType,
  Priority,
  ReportType,
  SenderType,
  TicketEventType,
  TicketStatus,
  VendorStatus,
} from '../enums.js';

/**
 * Zod schemas + inferred types for all 17 collections (data-model.md).
 * Foreign keys are modeled as `string` ids here; callers that request Directus
 * field expansion can refine with their own nested schemas.
 */

// --- vendors ---
export const VendorColors = z.object({
  primary: z.string().optional(),
  secondary: z.string().optional(),
  accent: z.string().optional(),
});
export const Vendor = z.object({
  ...directusDefaults,
  name: z.string().min(1),
  logo: z.string().nullable().optional(),
  colors: VendorColors.nullable().optional(),
  support_settings: z.record(z.unknown()).nullable().optional(),
  yiji_vendor_id: z.string(),
  status: VendorStatus.default('active'),
});
export type Vendor = z.infer<typeof Vendor>;

// --- teams ---
export const Team = z.object({
  ...directusDefaults,
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});
export type Team = z.infer<typeof Team>;

// --- users (extends directus_users) ---
export const NotificationPreferences = z.record(NotificationType, NotificationChannel);
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;
export const User = z.object({
  id: Id,
  email: z.string().email().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  status: z.string().optional(),
  team: z.string().nullable().optional(),
  locale: Locale.nullable().optional(),
  notification_preferences: NotificationPreferences.nullable().optional(),
});
export type User = z.infer<typeof User>;

// --- contacts ---
export const Contact = z.object({
  ...directusDefaults,
  vendor: z.string(),
  external_customer_id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  avatar: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type Contact = z.infer<typeof Contact>;

// --- conversations ---
export const Conversation = z.object({
  ...directusDefaults,
  vendor: z.string(),
  contact: z.string(),
  assigned_agent: z.string().nullable().optional(),
  assigned_team: z.string().nullable().optional(),
  status: ConversationStatus.default('open'),
  priority: Priority.default('medium'),
  last_message_at: z.string().datetime().nullable().optional(),
  unread_count_agent: z.number().int().nonnegative().default(0),
  csat_response: z.string().nullable().optional(),
});
export type Conversation = z.infer<typeof Conversation>;

// --- messages ---
export const ReadReceipt = z.object({ userId: z.string(), at: z.string().datetime() });
export const Message = z.object({
  ...directusDefaults,
  conversation: z.string(),
  sender_type: SenderType,
  sender_user: z.string().nullable().optional(),
  sender_contact: z.string().nullable().optional(),
  content: z.string(),
  is_internal_note: z.boolean().default(false),
  read_by: z.array(ReadReceipt).nullable().optional(),
});
export type Message = z.infer<typeof Message>;

// --- tickets ---
export const Ticket = z.object({
  ...directusDefaults,
  conversation: z.string().nullable().optional(),
  contact: z.string(),
  vendor: z.string(),
  subject: z.string().min(1),
  description: z.string().nullable().optional(),
  status: TicketStatus.default('new'),
  priority: Priority.default('medium'),
  assigned_agent: z.string().nullable().optional(),
  assigned_team: z.string().nullable().optional(),
  sla_policy: z.string().nullable().optional(),
  first_response_due_at: z.string().datetime().nullable().optional(),
  resolution_due_at: z.string().datetime().nullable().optional(),
  first_responded_at: z.string().datetime().nullable().optional(),
  resolved_at: z.string().datetime().nullable().optional(),
  closed_at: z.string().datetime().nullable().optional(),
});
export type Ticket = z.infer<typeof Ticket>;

// --- ticket_events (append-only) ---
export const TicketEvent = z.object({
  ...directusDefaults,
  ticket: z.string(),
  event_type: TicketEventType,
  actor: z.string().nullable().optional(),
  payload: z.record(z.unknown()).nullable().optional(),
});
export type TicketEvent = z.infer<typeof TicketEvent>;

// --- notifications ---
export const Notification = z.object({
  ...directusDefaults,
  recipient: z.string(),
  type: NotificationType,
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  link: z.string().nullable().optional(),
  read_at: z.string().datetime().nullable().optional(),
  channel_inapp_delivered_at: z.string().datetime().nullable().optional(),
  channel_email_delivered_at: z.string().datetime().nullable().optional(),
  payload: z.record(z.unknown()).nullable().optional(),
});
export type Notification = z.infer<typeof Notification>;

// --- sla_policies ---
export const BusinessHours = z.object({
  timezone: z.string(),
  // 0=Sunday..6=Saturday → list of [openHHmm, closeHHmm] windows
  days: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))),
});
export const SlaPolicy = z.object({
  ...directusDefaults,
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  applies_to_priority: z.array(Priority),
  first_response_minutes: z.number().int().positive(),
  resolution_minutes: z.number().int().positive(),
  warning_threshold_percent: z.number().int().min(1).max(100).default(80),
  business_hours: BusinessHours.nullable().optional(),
  active: z.boolean().default(true),
});
export type SlaPolicy = z.infer<typeof SlaPolicy>;

// --- automation_rules ---
export const AutomationCondition = z.object({
  field: z.string(),
  operator: z.enum(['eq', 'neq', 'in', 'nin', 'contains', 'gt', 'lt', 'gte', 'lte']),
  value: z.unknown(),
});
export const AutomationAction = z.object({
  type: AutomationActionType,
  value: z.unknown().optional(),
});
export const AutomationRule = z.object({
  ...directusDefaults,
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  trigger_event: AutomationTrigger,
  conditions: z.array(AutomationCondition).default([]),
  actions: z.array(AutomationAction).default([]),
  active: z.boolean().default(true),
  priority: z.number().int().default(0),
  last_triggered_at: z.string().datetime().nullable().optional(),
  trigger_count: z.number().int().nonnegative().default(0),
});
export type AutomationRule = z.infer<typeof AutomationRule>;

// --- reports ---
export const ReportFilters = z.object({
  vendor: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  date_from: z.string().nullable().optional(),
  date_to: z.string().nullable().optional(),
});
export const ReportSchedule = z.object({
  cron: z.string(),
  recipients: z.array(z.string().email()),
});
export const Report = z.object({
  ...directusDefaults,
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  type: ReportType,
  filters: ReportFilters.nullable().optional(),
  schedule: ReportSchedule.nullable().optional(),
  last_run_at: z.string().datetime().nullable().optional(),
  created_by: z.string().nullable().optional(),
});
export type Report = z.infer<typeof Report>;

// --- tags ---
export const Tag = z.object({
  ...directusDefaults,
  name: z.string().min(1),
  color: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
export type Tag = z.infer<typeof Tag>;

// --- custom_fields ---
export const CustomField = z.object({
  ...directusDefaults,
  entity_type: CustomFieldEntity,
  name: z.string().min(1),
  key: z.string().min(1),
  field_type: CustomFieldType,
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .nullable()
    .optional(),
  required: z.boolean().default(false),
  display_order: z.number().int().default(0),
});
export type CustomField = z.infer<typeof CustomField>;

// --- custom_field_values ---
export const CustomFieldValue = z.object({
  ...directusDefaults,
  custom_field: z.string(),
  entity_type: CustomFieldEntity,
  entity_id: z.string().uuid(),
  value: z.unknown(),
});
export type CustomFieldValue = z.infer<typeof CustomFieldValue>;

// --- csat_responses ---
export const CsatResponse = z.object({
  ...directusDefaults,
  conversation: z.string(),
  contact: z.string(),
  score: z.number().int().min(1).max(5),
  comment: z.string().nullable().optional(),
  submitted_at: z.string().datetime(),
});
export type CsatResponse = z.infer<typeof CsatResponse>;

/** Map of collection name → its slug, for the Directus client and bootstrap. */
export const COLLECTIONS = {
  vendors: 'vendors',
  teams: 'teams',
  contacts: 'contacts',
  conversations: 'conversations',
  messages: 'messages',
  tickets: 'tickets',
  ticket_events: 'ticket_events',
  notifications: 'notifications',
  sla_policies: 'sla_policies',
  automation_rules: 'automation_rules',
  reports: 'reports',
  tags: 'tags',
  custom_fields: 'custom_fields',
  custom_field_values: 'custom_field_values',
  csat_responses: 'csat_responses',
} as const;
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
