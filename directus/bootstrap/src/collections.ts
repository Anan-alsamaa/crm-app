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
  /**
   * Name of the M2M alias field to expose on collectionA (e.g. `conversations.tags`).
   * Without it the junction is only reachable directly; the owning collection
   * cannot read its related rows via a nested field. Set for every junction the
   * app reads as `A.<alias>`.
   */
  aliasA?: string;
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
    collection: 'brands',
    note: 'Restaurant brands — operations master data, editable in the admin portal.',
    fields: [
      { field: 'code', type: 'string', required: true, unique: true, note: 'e.g. LCP' },
      { field: 'name', type: 'string', required: true, note: 'e.g. La Casa Pasta' },
      {
        field: 'yiji_brand_name',
        type: 'string',
        index: true,
        note: 'Exactly what the Yiji order API returns in brandName. Only needed when it differs from name. Matching trims it — Yiji ships values with a leading space.',
      },
      {
        field: 'status',
        type: 'string',
        choices: ['active', 'inactive'],
        defaultValue: 'active',
      },
    ],
  },
  {
    collection: 'stores',
    note: 'Restaurant branches — operations master data. Mapped onto Yiji orders so tickets can be reported by store, brand and city.',
    fields: [
      { field: 'code', type: 'string', index: true, note: 'e.g. LCP-002' },
      { field: 'name', type: 'string', required: true, index: true, note: 'e.g. Marina Mall 2' },
      { field: 'city', type: 'string', index: true },
      { field: 'area_manager', type: 'string' },
      { field: 'chain_manager', type: 'string' },
      {
        field: 'yiji_restaurant_id',
        type: 'string',
        index: true,
        note: "Yiji's own restaurant id. Optional: the ops sheets do not carry it today, and matching falls back to a normalised name compare. Set it and this store matches exactly, regardless of naming drift.",
      },
      {
        field: 'status',
        type: 'string',
        choices: ['active', 'inactive'],
        defaultValue: 'active',
      },
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
      // Point-in-time snapshot of the Yiji order the ticket was raised about,
      // captured when the ticket is created from a chat. Structured JSON (not
      // prose in `description`) so the UI can render it as a real order card
      // and so it stays queryable. The order may change or vanish upstream,
      // which is exactly why this is a snapshot rather than a live lookup.
      { field: 'order_snapshot', type: 'json' },
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
          'sla_escalated',
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
    collection: 'routing_events',
    note: 'APPEND-ONLY record of auto-assignment outcomes (who was offered a conversation, and whether they answered)',
    fields: [
      {
        field: 'outcome',
        type: 'string',
        choices: ['answered', 'missed'],
        required: true,
      },
      {
        field: 'stage',
        type: 'string',
        choices: ['assign', 'escalate', 'broadcast'],
        required: true,
      },
      /* Seconds the agent had the conversation before this outcome was decided.
       * Stored rather than derived: the timer thresholds are configuration and
       * will change, and a historical row must keep the answer that was true
       * when it happened. */
      { field: 'seconds_held', type: 'integer' },
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
  // SET NULL, not CASCADE: deleting a brand must never silently delete the
  // branches under it — those rows carry the city and manager mapping the
  // ticket reports depend on.
  { collection: 'stores', field: 'brand', related: 'brands', onDelete: 'SET NULL' },
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
  {
    collection: 'routing_events',
    field: 'conversation',
    related: 'conversations',
    onDelete: 'CASCADE',
  },
  /* SET NULL, not CASCADE: a deleted agent must not erase the history of how
   * conversations were routed while they worked here. */
  {
    collection: 'routing_events',
    field: 'agent',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
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
    aliasA: 'tags',
  },
  {
    junction: 'conversations_tags',
    collectionA: 'conversations',
    fieldA: 'conversations_id',
    collectionB: 'tags',
    fieldB: 'tags_id',
    aliasA: 'tags',
  },
  {
    junction: 'tickets_tags',
    collectionA: 'tickets',
    fieldA: 'tickets_id',
    collectionB: 'tags',
    fieldB: 'tags_id',
    aliasA: 'tags',
  },
  {
    junction: 'messages_mentions',
    collectionA: 'messages',
    fieldA: 'messages_id',
    collectionB: 'directus_users',
    fieldB: 'directus_users_id',
    aliasA: 'mentions',
  },
  {
    junction: 'messages_files',
    collectionA: 'messages',
    fieldA: 'messages_id',
    collectionB: 'directus_files',
    fieldB: 'directus_files_id',
  },
  {
    junction: 'tickets_files',
    collectionA: 'tickets',
    fieldA: 'tickets_id',
    collectionB: 'directus_files',
    fieldB: 'directus_files_id',
    aliasA: 'attachments',
  },
];
