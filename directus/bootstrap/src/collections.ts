/**
 * Declarative Directus schema for Yiji CRM (data-model.md).
 * Consumed by apply.ts to create collections, fields, relations, and junctions
 * idempotently. This file is the version-controlled source of truth alongside
 * the generated snapshot in directus/snapshot/.
 */

export type FieldType =
  | 'string'
  | 'text'
  | 'uuid'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'json'
  | 'dateTime';

export interface FieldSpec {
  field: string;
  type: FieldType;
  /** enum choices (renders as dropdown; validated app-side via shared-types). */
  choices?: string[];
  required?: boolean;
  unique?: boolean;
  index?: boolean;
  defaultValue?: string | number | boolean | null;
  note?: string;
}

export interface CollectionSpec {
  collection: string;
  /** Human note shown in Directus. */
  note?: string;
  /** Singleton? (none here) */
  fields: FieldSpec[];
}

/** Many-to-one relations: a uuid field on `collection` pointing at `related`. */
export interface RelationSpec {
  collection: string;
  field: string;
  related: string;
  /** on-delete behavior */
  onDelete?: 'SET NULL' | 'CASCADE' | 'NO ACTION';
}

/** Many-to-many via a junction collection. */
export interface JunctionSpec {
  junction: string;
  collectionA: string; // owning
  fieldA: string; // junction field → A
  collectionB: string;
  fieldB: string; // junction field → B
}

const PRIORITY = ['low', 'medium', 'high', 'urgent'];

export const collections: CollectionSpec[] = [
  {
    collection: 'vendors',
    note: 'Yiji ecosystem vendors (data entities, not users)',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'logo', type: 'uuid', note: 'directus_files' },
      { field: 'colors', type: 'json' },
      { field: 'support_settings', type: 'json' },
      { field: 'yiji_vendor_id', type: 'string', required: true, unique: true },
      { field: 'status', type: 'string', choices: ['active', 'inactive'], defaultValue: 'active' },
    ],
  },
  {
    collection: 'teams',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
    ],
  },
  {
    collection: 'contacts',
    note: 'Customers of vendors; deduped per vendor by phone/email',
    fields: [
      { field: 'external_customer_id', type: 'string' },
      { field: 'name', type: 'string' },
      { field: 'phone', type: 'string', index: true },
      { field: 'email', type: 'string', index: true },
      { field: 'avatar', type: 'uuid', note: 'directus_files' },
      { field: 'metadata', type: 'json' },
    ],
  },
  {
    collection: 'conversations',
    fields: [
      {
        field: 'status',
        type: 'string',
        choices: ['open', 'pending', 'resolved', 'closed'],
        defaultValue: 'open',
      },
      { field: 'priority', type: 'string', choices: PRIORITY, defaultValue: 'medium' },
      { field: 'last_message_at', type: 'dateTime', index: true },
      { field: 'unread_count_agent', type: 'integer', defaultValue: 0 },
    ],
  },
  {
    collection: 'messages',
    fields: [
      { field: 'sender_type', type: 'string', choices: ['customer', 'agent', 'system'] },
      { field: 'content', type: 'text' },
      { field: 'is_internal_note', type: 'boolean', defaultValue: false },
      { field: 'read_by', type: 'json' },
    ],
  },
  {
    collection: 'tickets',
    fields: [
      { field: 'subject', type: 'string', required: true },
      { field: 'description', type: 'text' },
      {
        field: 'status',
        type: 'string',
        choices: ['new', 'open', 'pending', 'resolved', 'closed'],
        defaultValue: 'new',
      },
      { field: 'priority', type: 'string', choices: PRIORITY, defaultValue: 'medium' },
      { field: 'first_response_due_at', type: 'dateTime' },
      { field: 'resolution_due_at', type: 'dateTime' },
      { field: 'first_responded_at', type: 'dateTime' },
      { field: 'resolved_at', type: 'dateTime' },
      { field: 'closed_at', type: 'dateTime' },
    ],
  },
  {
    collection: 'ticket_events',
    note: 'APPEND-ONLY audit history (no update/delete in any role)',
    fields: [
      {
        field: 'event_type',
        type: 'string',
        choices: [
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
        ],
        required: true,
      },
      { field: 'payload', type: 'json' },
    ],
  },
  {
    collection: 'notifications',
    fields: [
      {
        field: 'type',
        type: 'string',
        choices: [
          'sla_warning',
          'sla_breach',
          'assignment',
          'mention',
          'ticket_update',
          'reminder',
          'escalation',
          'automation',
        ],
      },
      { field: 'title', type: 'string' },
      { field: 'body', type: 'text' },
      { field: 'link', type: 'string' },
      { field: 'read_at', type: 'dateTime' },
      { field: 'channel_inapp_delivered_at', type: 'dateTime' },
      { field: 'channel_email_delivered_at', type: 'dateTime' },
      { field: 'payload', type: 'json' },
    ],
  },
  {
    collection: 'sla_policies',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
      { field: 'applies_to_priority', type: 'json' },
      { field: 'first_response_minutes', type: 'integer', required: true },
      { field: 'resolution_minutes', type: 'integer', required: true },
      { field: 'warning_threshold_percent', type: 'integer', defaultValue: 80 },
      { field: 'business_hours', type: 'json' },
      { field: 'active', type: 'boolean', defaultValue: true },
    ],
  },
  {
    collection: 'automation_rules',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
      {
        field: 'trigger_event',
        type: 'string',
        choices: [
          'conversation_created',
          'message_received',
          'ticket_created',
          'ticket_status_changed',
          'sla_warning',
          'sla_breach',
          'inactivity',
          'keyword_matched',
        ],
      },
      { field: 'conditions', type: 'json' },
      { field: 'actions', type: 'json' },
      { field: 'active', type: 'boolean', defaultValue: true },
      { field: 'priority', type: 'integer', defaultValue: 0 },
      { field: 'last_triggered_at', type: 'dateTime' },
      { field: 'trigger_count', type: 'integer', defaultValue: 0 },
    ],
  },
  {
    collection: 'reports',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
      {
        field: 'type',
        type: 'string',
        choices: [
          'conversation_volume',
          'response_time',
          'sla_compliance',
          'ticket_resolution',
          'agent_productivity',
          'csat',
          'vendor_activity',
        ],
      },
      { field: 'filters', type: 'json' },
      { field: 'schedule', type: 'json' },
      { field: 'last_run_at', type: 'dateTime' },
    ],
  },
  {
    collection: 'tags',
    fields: [
      { field: 'name', type: 'string', required: true, unique: true },
      { field: 'color', type: 'string' },
      { field: 'description', type: 'text' },
    ],
  },
  {
    collection: 'custom_fields',
    fields: [
      { field: 'entity_type', type: 'string', choices: ['contact', 'conversation', 'ticket'] },
      { field: 'name', type: 'string', required: true },
      { field: 'key', type: 'string', required: true },
      {
        field: 'field_type',
        type: 'string',
        choices: ['text', 'number', 'boolean', 'date', 'select', 'multiselect'],
      },
      { field: 'options', type: 'json' },
      { field: 'required', type: 'boolean', defaultValue: false },
      { field: 'display_order', type: 'integer', defaultValue: 0 },
    ],
  },
  {
    collection: 'custom_field_values',
    fields: [
      { field: 'entity_type', type: 'string', choices: ['contact', 'conversation', 'ticket'] },
      { field: 'entity_id', type: 'uuid', required: true },
      { field: 'value', type: 'json' },
    ],
  },
  {
    collection: 'csat_responses',
    fields: [
      { field: 'score', type: 'integer', required: true },
      { field: 'comment', type: 'text' },
      { field: 'submitted_at', type: 'dateTime' },
    ],
  },
];

/** Many-to-one relations (foreign keys). */
export const relations: RelationSpec[] = [
  { collection: 'contacts', field: 'vendor', related: 'vendors', onDelete: 'CASCADE' },
  { collection: 'conversations', field: 'vendor', related: 'vendors', onDelete: 'CASCADE' },
  { collection: 'conversations', field: 'contact', related: 'contacts', onDelete: 'CASCADE' },
  {
    collection: 'conversations',
    field: 'assigned_agent',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  {
    collection: 'conversations',
    field: 'assigned_team',
    related: 'teams',
    onDelete: 'SET NULL',
  },
  {
    collection: 'conversations',
    field: 'csat_response',
    related: 'csat_responses',
    onDelete: 'SET NULL',
  },
  { collection: 'messages', field: 'conversation', related: 'conversations', onDelete: 'CASCADE' },
  {
    collection: 'messages',
    field: 'sender_user',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  { collection: 'messages', field: 'sender_contact', related: 'contacts', onDelete: 'SET NULL' },
  { collection: 'tickets', field: 'conversation', related: 'conversations', onDelete: 'SET NULL' },
  { collection: 'tickets', field: 'contact', related: 'contacts', onDelete: 'CASCADE' },
  { collection: 'tickets', field: 'vendor', related: 'vendors', onDelete: 'CASCADE' },
  {
    collection: 'tickets',
    field: 'assigned_agent',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  { collection: 'tickets', field: 'assigned_team', related: 'teams', onDelete: 'SET NULL' },
  { collection: 'tickets', field: 'sla_policy', related: 'sla_policies', onDelete: 'SET NULL' },
  { collection: 'ticket_events', field: 'ticket', related: 'tickets', onDelete: 'CASCADE' },
  { collection: 'ticket_events', field: 'actor', related: 'directus_users', onDelete: 'SET NULL' },
  {
    collection: 'notifications',
    field: 'recipient',
    related: 'directus_users',
    onDelete: 'CASCADE',
  },
  { collection: 'reports', field: 'created_by', related: 'directus_users', onDelete: 'SET NULL' },
  {
    collection: 'custom_field_values',
    field: 'custom_field',
    related: 'custom_fields',
    onDelete: 'CASCADE',
  },
  {
    collection: 'csat_responses',
    field: 'conversation',
    related: 'conversations',
    onDelete: 'CASCADE',
  },
  { collection: 'csat_responses', field: 'contact', related: 'contacts', onDelete: 'CASCADE' },
  { collection: 'directus_users', field: 'team', related: 'teams', onDelete: 'SET NULL' },
];

/** Many-to-many relations via junction collections. */
export const junctions: JunctionSpec[] = [
  {
    junction: 'contacts_tags',
    collectionA: 'contacts',
    fieldA: 'contacts_id',
    collectionB: 'tags',
    fieldB: 'tags_id',
  },
  {
    junction: 'conversations_tags',
    collectionA: 'conversations',
    fieldA: 'conversations_id',
    collectionB: 'tags',
    fieldB: 'tags_id',
  },
  {
    junction: 'tickets_tags',
    collectionA: 'tickets',
    fieldA: 'tickets_id',
    collectionB: 'tags',
    fieldB: 'tags_id',
  },
  {
    junction: 'messages_mentions',
    collectionA: 'messages',
    fieldA: 'messages_id',
    collectionB: 'directus_users',
    fieldB: 'directus_users_id',
  },
  {
    junction: 'messages_files',
    collectionA: 'messages',
    fieldA: 'messages_id',
    collectionB: 'directus_files',
    fieldB: 'directus_files_id',
  },
];
