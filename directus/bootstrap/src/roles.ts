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
      ...readOnly('tags'),
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
      { collection: 'messages', action: 'update' },
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
      ...readOnly('ticket_events'),
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
      { collection: 'csat_responses', action: 'create' },
      { collection: 'csat_responses', action: 'read' },
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
      { collection: 'automation_rules', action: 'read' },
      { collection: 'automation_rules', action: 'update' },
      { collection: 'reports', action: 'read' },
      { collection: 'reports', action: 'update' },
      ...readOnly('sla_policies'),
      ...readOnly('directus_users'),
      ...readOnly('contacts'),
      ...readOnly('tags'),
      ...readOnly('custom_fields'),
      ...readOnly('custom_field_values'),
    ],
  },
  {
    name: 'svc-ai-gateway',
    description: 'Service account: AI gateway. READ-ONLY.',
    appAccess: false,
    adminAccess: false,
    serviceTokenEnv: 'SVC_AI_TOKEN',
    permissions: [...readOnly('conversations'), ...readOnly('messages')],
  },
];
