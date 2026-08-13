/**
 * Roles and permission matrix (contracts/directus-collections.md).
 * Consumed by apply.ts to create Directus roles + permissions.
 *
 * Hard rules encoded here:
 *   - ticket_events is append-only (create + read only) for every role.
 *   - svc-ai-gateway is read-only (conversations + messages).
 *   - Admin role has admin_access=false (cannot change schema / delete Administrator).
 *   - Agent access is scoped via permission filters.
 */

import {
  COMPENSATION_COLLECTIONS,
  COMPENSATION_OPS_EDITABLE_FIELDS,
  PROVISION_COMPENSATION,
} from './compensation.js';

export type Action = 'create' | 'read' | 'update' | 'delete';

export interface PermissionSpec {
  collection: string;
  action: Action;
  /** Directus filter rule (JSON). Empty object = unrestricted. */
  fields?: string[]; // defaults to all (['*'])
  permissions?: Record<string, unknown>; // row filter
}

export interface RoleSpec {
  /** Stable key used to look up / create the role. */
  name: string;
  description: string;
  /** Directus app access (portal/admin app login). Service accounts: false. */
  appAccess: boolean;
  /** Full admin (schema + everything). Only Administrator. */
  adminAccess: boolean;
  /** null => use adminAccess (Administrator); otherwise explicit permissions. */
  permissions: PermissionSpec[] | null;
  /** If true, this role's static token is seeded from an env var. */
  serviceTokenEnv?: string;
}

const CRUD: Action[] = ['create', 'read', 'update', 'delete'];

/** Helper: full CRUD on a collection. */
const crud = (collection: string): PermissionSpec[] =>
  CRUD.map((action) => ({ collection, action }));

/** Helper: read-only on a collection. */
const readOnly = (collection: string): PermissionSpec[] => [{ collection, action: 'read' }];

/** Append-only: create + read only (never update/delete). */
const appendOnly = (collection: string): PermissionSpec[] => [
  { collection, action: 'create' },
  { collection, action: 'read' },
];

const ALL_BUSINESS = [
  'vendors',
  'teams',
  // Restaurant master data (brands + their branches). Admins maintain these by
  // hand and via CSV import; every other role only reads them.
  //
  // `stores` is NOT here — it needs field-level restriction so only the
  // Administrator can set yiji_restaurant_id. See STORE_FIELDS_NO_YIJI_ID.
  'brands',
  'contacts',
  'conversations',
  'messages',
  'tickets',
  'notifications',
  'sla_policies',
  'automation_rules',
  'reports',
  'tags',
  'custom_fields',
  'custom_field_values',
  'csat_responses',
  // Which complaint types reach the branch, and the queue of what was decided.
  // Supervisors own the rules; the queue is theirs to inspect and retry.
  'store_notify_rules',
  'store_notifications',
  // The supervisor IS the admin role here: approving a coupon is the one thing
  // an agent must not be able to do for themselves.
  'coupon_approvals',
];

/**
 * Every store field EXCEPT `yiji_restaurant_id`.
 *
 * That id is the join key between a branch and Yiji's order feed. Getting it
 * wrong does not error — it silently attributes a ticket to the wrong branch,
 * and every by-store report inherits the mistake with no visible symptom. So
 * it is writable ONLY by the Administrator (the sole role with admin_access);
 * the CRM `Admin` role maintains everything else about a store but cannot
 * touch it. Field lists are the enforcement — the portal disabling the input
 * is only a courtesy, and an API call would bypass that.
 */
const STORE_FIELDS_NO_YIJI_ID = [
  'code',
  'name',
  'city',
  'area_manager',
  'chain_manager',
  'brand',
  'status',
];

// Agent row-level scoping filters.
const ASSIGNED_OR_UNASSIGNED = {
  _or: [{ assigned_agent: { _eq: '$CURRENT_USER' } }, { assigned_agent: { _null: true } }],
};
const SELF_RECIPIENT = { recipient: { _eq: '$CURRENT_USER' } };

export const roles: RoleSpec[] = [
  {
    name: 'Administrator',
    description: 'Project owner / superuser. Full access.',
    appAccess: true,
    adminAccess: true,
    permissions: null,
  },
  {
    name: 'Admin',
    description: 'CRM administrators. Full business CRUD + user/team mgmt; no schema changes.',
    appAccess: true,
    adminAccess: false,
    permissions: [
      ...ALL_BUSINESS.flatMap(crud),
      ...crud('directus_users'),
      ...appendOnly('ticket_events'),
      // Stores: full read/delete, but create and update are field-scoped so the
      // Yiji restaurant id stays Administrator-only (see STORE_FIELDS_NO_YIJI_ID).
      { collection: 'stores', action: 'read' },
      { collection: 'stores', action: 'delete' },
      { collection: 'stores', action: 'create', fields: STORE_FIELDS_NO_YIJI_ID },
      { collection: 'stores', action: 'update', fields: STORE_FIELDS_NO_YIJI_ID },
    ],
  },
  {
    name: 'Agent',
    description: 'Support agents. Scoped read/write on assigned work; read-only config.',
    appAccess: true,
    adminAccess: false,
    permissions: [
      ...readOnly('vendors'),
      ...readOnly('teams'),
      // Read-only so the agent inbox can show which branch an order came from
      // without letting agents edit the operations team's master data.
      ...readOnly('brands'),
      ...readOnly('stores'),
      // Agents can create custom tags on the fly (and rename/recolour), read
      // them, and delete one from the library (cascades out of all junctions) —
      // in addition to assigning via the conversations_tags junction below.
      { collection: 'tags', action: 'read' },
      { collection: 'tags', action: 'create' },
      { collection: 'tags', action: 'update' },
      { collection: 'tags', action: 'delete' },
      ...readOnly('sla_policies'),
      ...readOnly('automation_rules'),
      ...readOnly('custom_fields'),
      ...readOnly('csat_responses'),
      { collection: 'directus_users', action: 'read' },
      // Self-service update for notification preferences + own profile.
      {
        collection: 'directus_users',
        action: 'update',
        fields: ['notification_preferences', 'locale', 'first_name', 'last_name'],
        permissions: { id: { _eq: '$CURRENT_USER' } },
      },
      { collection: 'contacts', action: 'read' },
      { collection: 'contacts', action: 'update' },
      // conversations: scoped
      { collection: 'conversations', action: 'read', permissions: ASSIGNED_OR_UNASSIGNED },
      { collection: 'conversations', action: 'create' },
      { collection: 'conversations', action: 'update', permissions: ASSIGNED_OR_UNASSIGNED },
      { collection: 'messages', action: 'create' },
      { collection: 'messages', action: 'read' },
      // NOTE (H-3): `messages.update` is intentionally NOT granted to agents.
      // Messages are an immutable chat record; agents must not edit historical
      // content (tampering), and the app never PATCHes a message via the agent
      // token — the gateway is the sole writer (service token).
      //
      // FOLLOW-UP (tenant isolation): `messages.read` + `contacts.read` are still
      // unfiltered (all-vendor), matching the current shared-inbox design.
      // Scoping them per vendor/team is a product decision + a core read-path
      // change that must be integration-tested before rollout.
      // tickets: scoped to assigned agent
      {
        collection: 'tickets',
        action: 'read',
        permissions: { assigned_agent: { _eq: '$CURRENT_USER' } },
      },
      { collection: 'tickets', action: 'create' },
      {
        collection: 'tickets',
        action: 'update',
        permissions: { assigned_agent: { _eq: '$CURRENT_USER' } },
      },
      // Append-only: agents add internal notes as 'commented' ticket_events.
      ...appendOnly('ticket_events'),
      // The branch-notification rules decide whether saving a ticket also
      // queues a note to the store, so the form has to be able to read them.
      // Read-only: which complaint types are the branch's business is an
      // operations decision, made in the admin console.
      ...readOnly('store_notify_rules'),
      // Append-only for the same reason ticket_events is: the agent's save
      // creates the queue entry, and nothing in the portal may go back and
      // rewrite what a branch was told.
      ...appendOnly('store_notifications'),
      /**
       * Coupon approvals: an agent may ASK, and may see what became of their
       * own asks. They may not update a row at all — not their own, not
       * anybody's. Deciding is the supervisor's act, and an agent who could
       * patch `status` would be approving their own coupon, which is the one
       * thing this whole collection exists to prevent.
       */
      { collection: 'coupon_approvals', action: 'create' },
      {
        collection: 'coupon_approvals',
        action: 'read',
        permissions: { requested_by: { _eq: '$CURRENT_USER' } },
      },
      { collection: 'notifications', action: 'read', permissions: SELF_RECIPIENT },
      {
        collection: 'notifications',
        action: 'update',
        fields: ['read_at'],
        permissions: SELF_RECIPIENT,
      },
      { collection: 'custom_field_values', action: 'create' },
      { collection: 'custom_field_values', action: 'read' },
      { collection: 'custom_field_values', action: 'update' },
      // Tag a conversation (US3): m2m junction needs create + read + delete.
      { collection: 'conversations_tags', action: 'create' },
      { collection: 'conversations_tags', action: 'read' },
      { collection: 'conversations_tags', action: 'delete' },
      // Tag a contact (same junction pattern).
      { collection: 'contacts_tags', action: 'create' },
      { collection: 'contacts_tags', action: 'read' },
      { collection: 'contacts_tags', action: 'delete' },
      // Attachments: upload files + read their metadata to render chips; read the
      // message↔file junction. The gateway writes the junction on send.
      { collection: 'directus_files', action: 'create' },
      { collection: 'directus_files', action: 'read' },
      { collection: 'messages_files', action: 'read' },
      // Ticket attachments: agents upload + link files to tickets directly.
      { collection: 'tickets_files', action: 'create' },
      { collection: 'tickets_files', action: 'read' },
      { collection: 'tickets_files', action: 'delete' },
      // Compensation ops queue (/compensation). Ops agents have no Directus
      // access, so the portal is their only surface: read the queue + the issue
      // catalog they classify with. Unfiltered — a compensation request has no
      // assigned-agent column; the queue is worked as a shared pool.
      // Only when this Directus actually owns compensation — otherwise these are
      // grants on collections that do not exist here.
      ...(PROVISION_COMPENSATION ? COMPENSATION_COLLECTIONS.flatMap(readOnly) : []),
      // Field-scoped update: ops prepare a request for the workflow buttons.
      // Status, computed values and coupon links stay read-only here — those are
      // written by the Directus flows, which run with their own accountability.
      ...(PROVISION_COMPENSATION
        ? [
            {
              collection: 'compensation_requests',
              action: 'update' as Action,
              fields: COMPENSATION_OPS_EDITABLE_FIELDS,
            },
          ]
        : []),
    ],
  },
  {
    name: 'svc-socket-gateway',
    description: 'Service account: realtime gateway.',
    appAccess: false,
    adminAccess: false,
    serviceTokenEnv: 'SVC_GATEWAY_TOKEN',
    permissions: [
      { collection: 'contacts', action: 'create' },
      { collection: 'contacts', action: 'read' },
      { collection: 'contacts', action: 'update' },
      { collection: 'conversations', action: 'create' },
      { collection: 'conversations', action: 'read' },
      { collection: 'conversations', action: 'update' },
      { collection: 'messages', action: 'create' },
      { collection: 'messages', action: 'read' },
      { collection: 'messages', action: 'update' },
      { collection: 'messages', action: 'delete' },
      // Attachments: upload customer files (proxy) + link them to messages.
      { collection: 'directus_files', action: 'create' },
      { collection: 'directus_files', action: 'read' },
      { collection: 'messages_files', action: 'create' },
      { collection: 'messages_files', action: 'read' },
      { collection: 'csat_responses', action: 'create' },
      { collection: 'csat_responses', action: 'read' },
      // READ-ONLY on tickets: POST /jobs/notify-assignment re-reads the assigned
      // entity server-side to derive the notification recipient (the caller's own
      // token can't — an agent loses ticket read access the moment they hand it
      // to a colleague). The gateway never writes tickets.
      { collection: 'tickets', action: 'read' },
      ...readOnly('directus_users'),
      ...readOnly('vendors'),
      ...readOnly('teams'),
    ],
  },
  {
    name: 'svc-workers',
    description: 'Service account: BullMQ workers.',
    appAccess: false,
    adminAccess: false,
    serviceTokenEnv: 'SVC_WORKERS_TOKEN',
    permissions: [
      ...crud('tickets'),
      ...appendOnly('ticket_events'),
      { collection: 'notifications', action: 'create' },
      { collection: 'notifications', action: 'read' },
      { collection: 'notifications', action: 'update' },
      { collection: 'conversations', action: 'read' },
      { collection: 'conversations', action: 'update' },
      // The routing worker appends auto-assignment outcomes. Without create it
      // fails AFTER assigning, which leaves the conversation routed but the
      // metric silently empty — the worst shape, because the feature looks like
      // it worked.
      { collection: 'routing_events', action: 'create' },
      { collection: 'routing_events', action: 'read' },
      /* The ladder decides whether to escalate by counting AGENT replies, so the
       * worker must be able to read messages. Without it the assign stage writes
       * the assignment and then throws on the very next call — the conversation
       * looks correctly routed while the escalation timer was never armed, which
       * is a silent half-failure rather than a visible one. */
      { collection: 'messages', action: 'read' },
      { collection: 'automation_rules', action: 'read' },
      { collection: 'automation_rules', action: 'update' },
      { collection: 'reports', action: 'read' },
      { collection: 'reports', action: 'update' },
      ...readOnly('sla_policies'),
      ...readOnly('directus_users'),
      ...readOnly('contacts'),
      // CSV import (imports processor) creates new contacts after dedup.
      { collection: 'contacts', action: 'create' },
      ...readOnly('tags'),
      ...readOnly('custom_fields'),
      ...readOnly('custom_field_values'),
      // The imports processor downloads the uploaded CSV: readFile() + a bearer
      // GET on /assets/<id> (processors/imports.ts:141-147). Without this the
      // whole contact-import feature 403s.
      ...readOnly('directus_files'),
      // The `csat` report aggregates satisfaction scores (processors/reports.ts:280).
      ...readOnly('csat_responses'),
      // The automation `add_tag` action inserts the junction row
      // (processors/automation.ts:149).
      { collection: 'conversations_tags', action: 'create' },
      { collection: 'conversations_tags', action: 'read' },
      { collection: 'contacts_tags', action: 'create' },
      { collection: 'contacts_tags', action: 'read' },
    ],
  },
  {
    name: 'svc-ai-gateway',
    description: 'Service account: AI gateway. READ-ONLY.',
    appAccess: false,
    adminAccess: false,
    serviceTokenEnv: 'SVC_AI_TOKEN',
    permissions: [
      ...readOnly('conversations'),
      ...readOnly('messages'),
      // C-1: the gateway resolves which role ids are admin roles (to gate the AI
      // admin endpoints from the caller's VERIFIED Directus role). Needs read on
      // directus_roles via the service token.
      { collection: 'directus_roles', action: 'read' },
    ],
  },
];
