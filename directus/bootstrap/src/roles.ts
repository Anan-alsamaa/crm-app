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
  // Editable dropdown values, declarative app roles, and small settings —
  // the operations team maintains all three from the portal.
  'option_lists',
  'app_roles',
  'app_settings',
  // Which complaint types reach the branch, and the queue of what was decided.
  // Supervisors own the rules; the queue is theirs to inspect and retry.
  'store_notify_rules',
  'store_notifications',
  // The ready-reply library agents pick from. Operations wording, so operations
  // maintain it.
  'quick_replies',
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

/**
 * Agent row-level scoping for conversations.
 *
 * Three ways a chat is yours to work:
 *
 *  - it is assigned to you;
 *  - nobody owns it (the pool — where the escalation ladder drops a chat
 *    nobody picked up, and an agent who could not see those would never
 *    rescue one);
 *  - it is assigned to YOUR TEAM. This is the handover case: the night shift
 *    passes a chat to the day shift by assigning the Day shift team, and every
 *    agent on that team has to be able to see and answer it. Without this
 *    clause a team assignment is decoration — the chat would remain invisible
 *    to exactly the people it was handed to.
 *
 * The `_nnull` guard on the team clause is NOT redundant. For an agent whose
 * own `team` is null, `$CURRENT_USER.team` resolves to null and Directus
 * renders `assigned_team _eq null` as an IS NULL predicate that MATCHES — so
 * the clause silently degenerates into "every chat that has no team", which is
 * most of them. A team-less agent could therefore read and, through the same
 * filter on update, reassign any colleague's conversation. Requiring the row's
 * team to be non-null makes the clause vacuous for a team-less viewer instead
 * of universal, which is the direction an access rule must fail in.
 */
const ASSIGNED_OR_UNASSIGNED = {
  _or: [
    { assigned_agent: { _eq: '$CURRENT_USER' } },
    { assigned_agent: { _null: true } },
    {
      _and: [{ assigned_team: { _nnull: true } }, { assigned_team: { _eq: '$CURRENT_USER.team' } }],
    },
  ],
};

/**
 * The same ownership test, reached THROUGH the parent conversation.
 *
 * `messages` carries no `assigned_agent` of its own — only a `conversation`
 * foreign key — so scoping the conversation without scoping this leaves the
 * thread contents readable by anybody. That is not a smaller leak than the
 * conversation row: the row is metadata, the messages are what the customer
 * actually said, including the phone number in the walk-in note. Verified
 * against production before fixing: an agent could read "Hey there" and the
 * contact's number on a chat owned by a colleague.
 *
 * A message you may not read is also one you may not mark read or reply to,
 * which the update/create grants already gate separately.
 */
const CONVERSATION_ASSIGNED_OR_UNASSIGNED = { conversation: ASSIGNED_OR_UNASSIGNED };

/**
 * The same scoping, reached through a message's parent conversation.
 *
 * `messages.read` used to carry no filter at all, so an agent who could not
 * LIST a conversation could still read every word in it by id. A chat log is
 * the most sensitive thing in the product; scoping the container and leaving
 * its contents open is not a smaller version of the same rule.
 */
/**
 * What an agent may change on their own ticket.
 *
 * An allow-list, and the omissions are the point:
 *
 *   coupon_code / coupon_value / coupon_percent — money. These are written by
 *     the supervisor's approval flow and by nothing else. The portal routes a
 *     requested coupon into `coupon_approvals`, but a UI that asks politely is
 *     not a control while the same token can PATCH the column directly: an
 *     agent could grant themselves any coupon with one API call, and the
 *     approval queue would never hear about it.
 *
 *   sla_policy / first_response_due_at / resolution_due_at — the deadlines an
 *     agent is measured against. Writable by the SLA worker's service token.
 *
 *   order_snapshot / order_id / store_snapshot — frozen evidence of what was
 *     ordered and from where. Stamped at creation; rewriting them later would
 *     silently rewrite every past report.
 *
 * `compensation` stays writable: with no coupon attached it is a statement of
 * fact about how a complaint was settled, not a payment. splitCouponForApproval
 * already withholds it while a coupon is pending, so it cannot be used to claim
 * a coupon exists before one is approved.
 */
const TICKET_FIELDS_AGENT_WRITABLE = [
  'subject',
  'description',
  'status',
  'priority',
  'first_responded_at',
  'resolved_at',
  'closed_at',
  'assigned_agent',
  'assigned_team',
  'store',
  'complaint_date',
  'complaint_type',
  'service_type',
  'complaint_source',
  'communication_method',
  'response_desc',
  'compensation',
  /*
   * Editable, not just creatable.
   *
   * `tickets.create` grants every field, so leaving this out would let an
   * agent SET the number when raising the ticket and then never correct a
   * typo — the write would be accepted by the client and dropped by Directus,
   * which is the silent-failure shape this codebase keeps producing. A phone
   * number taken down by ear is exactly the field that needs correcting.
   */
  'customer_phone',
];

const SELF_RECIPIENT = { recipient: { _eq: '$CURRENT_USER' } };

/**
 * Collections whose change history the console can read back.
 *
 * One list because two grants have to agree: revisions carry WHAT changed,
 * activity carries WHO and WHEN, and a drawer with one but not the other shows
 * edits made by nobody.
 *
 * Anything added here must already be readable by the role it is granted to —
 * this widens the audit trail, it does not open a collection.
 */
const AUDITED_COLLECTIONS = ['tickets', 'coupon_approvals'];

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
      /* Change history = Directus's own activity + revisions. The Admin role
       * has no admin_access, so the system tables need explicit grants.
       *
       * SCOPED TO A LIST, not to one collection. It named `tickets` alone, so
       * the Compensation report's History button read an empty result on every
       * coupon — not a 403 anyone could report, but a drawer politely saying
       * "no changes recorded" about a row that had been approved, edited and
       * re-priced. A permission filter returning nothing is indistinguishable
       * from a row with nothing to show. */
      {
        collection: 'directus_activity',
        action: 'read',
        permissions: { collection: { _in: AUDITED_COLLECTIONS } },
      },
      {
        collection: 'directus_revisions',
        action: 'read',
        permissions: { collection: { _in: AUDITED_COLLECTIONS } },
      },
      ...appendOnly('ticket_events'),
      // Stores: full read/delete, but create and update are field-scoped so the
      // Yiji restaurant id stays Administrator-only (see STORE_FIELDS_NO_YIJI_ID).
      { collection: 'stores', action: 'read' },
      { collection: 'stores', action: 'delete' },
      { collection: 'stores', action: 'create', fields: STORE_FIELDS_NO_YIJI_ID },
      { collection: 'stores', action: 'update', fields: STORE_FIELDS_NO_YIJI_ID },
      // Auto-assignment outcomes. The workers write these; the dashboard, the
      // agent-performance page and the Agent KPI report all READ them, and
      // without the grant every one of those surfaces answered 403 and showed
      // the reader a zero instead of a number. A missing measure that renders
      // as "0" is worse than an error, because nobody goes looking.
      ...readOnly('routing_events'),
      // Late-order decisions. The Agent KPI report and the late-orders queue
      // both read these; without the grant the report renders a plausible zero
      // rather than an error, which is the shape nobody goes looking at.
      ...readOnly('late_order_decisions'),
      // Junction tables. An Admin is a superset of an Agent for reading, but
      // these were only ever granted to the Agent role — so an admin opening a
      // tagged conversation, a ticket with an attachment, or a message with a
      // mention got a 403 on the join and a view with the tags and files
      // silently missing.
      ...crud('conversations_tags'),
      ...crud('contacts_tags'),
      ...crud('tickets_files'),
      ...crud('messages_files'),
      ...crud('messages_mentions'),
      // Compensation ops queue. The Agent role was granted these and the Admin
      // role was not, so /reports/operational-kpi/compensation answered 403 for
      // every CRM administrator while answering 200 for their own agents — the
      // page rendered, empty, looking like there was no compensation data.
      //
      // Same shape as the Agent grant on purpose: read the queue, and the same
      // field-scoped update. Status, computed values and coupon links stay
      // read-only because the Directus flows write them, and a flow that runs
      // with its own accountability is the whole point of that split.
      ...(PROVISION_COMPENSATION ? COMPENSATION_COLLECTIONS.flatMap(readOnly) : []),
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
      /*
       * An agent CREATES a customer when raising a ticket for somebody the CRM
       * has never seen — a complaint phoned in, or made at a counter.
       *
       * Granted 2026-09-16. Without it the Add-ticket page could offer to
       * record the customer and then fail with a 403 at save: the exact shape
       * of silent failure this codebase keeps producing, and the whole point of
       * the single customer field is that a stranger is never a dead end.
       *
       * This is not a new class of trust. A walk-in scanning a branch QR code
       * already creates a contacts row (the gateway does it on their behalf);
       * the only thing that changes is which hand types the number. The row is
       * the same shape either way, `external_customer_id` left null because we
       * genuinely do not know their Yiji id.
       */
      { collection: 'contacts', action: 'create' },
      /* conversations: an agent READS AND WRITES only their own / their team's.
       *
       * THE HISTORY OF THIS LINE, because it has moved twice and each move had
       * a real cost:
       *
       *   2026-08-14  scoped, after an incident where team-less agents
       *               inherited everything through a null-team match.
       *   2026-08-16  widened to unrestricted read: the operations manager
       *               reported that a returning customer routed to a different
       *               agent arrived with no history, so the new agent asked
       *               them to repeat a story the company already had.
       *   2026-09-14  scoped again, by the owner: a chat assigned to one agent
       *       must not be visible to the others. Only a role holding
       *               `view_all_chats` — WeCare Admin, Supervisor, Viewer, the
       *               managers — sees every chat.
       *
       * The 08-16 concern is real and is NOT solved by this rule, so say so
       * plainly: an agent picking up a returning customer will no longer see
       * the earlier conversations of a colleague. What they still get is the
       * customer's own thread once it is assigned to them, and a supervisor or
       * WeCare Admin can always see the whole picture. If the history gap bites
       * again, the fix is a read-only history surface scoped to the CONTACT,
       * not re-opening every chat to everybody.
       */
      { collection: 'conversations', action: 'read', permissions: ASSIGNED_OR_UNASSIGNED },
      { collection: 'conversations', action: 'create' },
      { collection: 'conversations', action: 'update', permissions: ASSIGNED_OR_UNASSIGNED },
      { collection: 'messages', action: 'create' },
      /* Messages follow their conversation — in BOTH directions.
       *
       * This was unrestricted while `conversations.read` was, on the reasoning
       * that a history list you cannot open is not history. Now that the
       * conversation is scoped again (2026-09-14), leaving this open would have
       * been the worse half of the pair: the conversation row is metadata, the
       * messages are what the customer actually wrote.
       */
      { collection: 'messages', action: 'read', permissions: CONVERSATION_ASSIGNED_OR_UNASSIGNED },
      // NOTE (H-3): `messages.update` is intentionally NOT granted to agents.
      // Messages are an immutable chat record; agents must not edit historical
      // content (tampering), and the app never PATCHes a message via the agent
      // token — the gateway is the sole writer (service token).
      //
      // FOLLOW-UP (tenant isolation): `contacts.read` is still unfiltered
      // (all-vendor), matching the current shared-inbox design. Scoping it per
      // vendor is a product decision that must be integration-tested first.
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
        fields: TICKET_FIELDS_AGENT_WRITABLE,
        permissions: { assigned_agent: { _eq: '$CURRENT_USER' } },
      },
      // Append-only: agents add internal notes as 'commented' ticket_events.
      ...appendOnly('ticket_events'),
      /**
       * Who was offered which chat, and whether they answered.
       *
       * Read-only and unfiltered. It carries no customer content — a
       * conversation id, an agent id, an outcome and a duration — and both
       * portals already show agents how they compare with each other on
       * response time, so scoping this to the viewer's own rows would only
       * break the common-chats comparison while hiding nothing that is not
       * already on the page.
       */
      { collection: 'routing_events', action: 'read' },
      /*
       * Late-order decisions: the agent WRITES these from the queue.
       *
       * Read is unscoped on purpose. The queue hides what has already been
       * handled, so an agent who could only see their OWN decisions would be
       * offered orders a colleague dealt with a minute ago — two agents
       * compensating the same customer for the same order is exactly the
       * failure this record exists to prevent.
       */
      { collection: 'late_order_decisions', action: 'create' },
      { collection: 'late_order_decisions', action: 'read' },
      // Dropdown values + the WhatsApp template: the form reads these live.
      ...readOnly('option_lists'),
      ...readOnly('app_settings'),
      /**
       * The ticket change history is Directus's OWN audit trail — activity and
       * revisions — not a custom log. Every write path (portal, import, raw
       * API) lands in it with the actor attached, which a client-side diff
       * could never promise. Scoped to tickets: chat content history stays out.
       */
      {
        collection: 'directus_activity',
        action: 'read',
        permissions: { collection: { _eq: 'tickets' } },
      },
      {
        collection: 'directus_revisions',
        action: 'read',
        permissions: { collection: { _eq: 'tickets' } },
      },
      // Ready-made replies. Read-only: the wording customers receive is the
      // operations team's to standardise, not something to be edited mid-chat.
      ...readOnly('quick_replies'),
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
       * Coupon approvals: an agent may ASK, and may read the whole queue —
       * compensation is worked as a shared pool, and every agent answering a
       * customer needs to see what any colleague already asked for (one source
       * of truth, by request). They may not update a row at all — not their
       * own, not anybody's. Deciding is the supervisor's act, and an agent who
       * could patch `status` would be approving their own coupon, which is the
       * one thing this whole collection exists to prevent.
       */
      { collection: 'coupon_approvals', action: 'create' },
      { collection: 'coupon_approvals', action: 'read' },
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
      /*
       * RELEASE STATE — which build is live, and which are waiting.
       *
       * The gateway owns these two rows because it is the only service that
       * can both read them for the admin portal and act on them: releasing
       * copies `pending/index.html` over the live one in S3. Directus itself
       * cannot reach S3, and the portal must not hold AWS credentials.
       *
       * Two rows only (`release.live`, `release.pending`), but the permission
       * is collection-wide because Directus scopes by collection, not by key.
       * `app_settings` holds small operational settings the team already
       * edits, so this is not a widening into customer data.
       */
      { collection: 'app_settings', action: 'read' },
      { collection: 'app_settings', action: 'create' },
      { collection: 'app_settings', action: 'update' },
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
      /*
       * ROUTING READS THE ROLE, NOT JUST THE USER.
       *
       * `agentsByLoad` filters the roster by `role.name` so that a chat is
       * never offered to a service account or an Administrator. Reading a
       * user's role traverses into `directus_roles`, and without permission
       * there Directus refuses the WHOLE query — FORBIDDEN, not an empty list.
       *
       * That broke every routing job on both staging and production: each one
       * threw before choosing anybody and retried five times, so auto-assignment
       * never assigned a single conversation. Found by an end-to-end probe on
       * staging (2026-09-10); the worker log said only "job failed", because the
       * SDK's rejection is not an Error and its message was being dropped.
       */
      ...readOnly('directus_roles'),
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
      /*
       * COUPON DELIVERY. The push re-reads the approval with this token, then
       * writes the receipt and moves it to `assigned`; the delivery sweep
       * queries the same collection for anything still owed.
       *
       * Without these the whole feature 403s at the first call — the approval
       * is recorded, the job is queued, the worker cannot see the row, and the
       * customer never gets the coupon a supervisor granted. Nothing on any
       * screen says so, which is the exact shape this codebase keeps finding.
       *
       * Read + update only. The worker must never CREATE an approval: granting
       * a coupon is a decision a person makes, and an account that can write
       * one is an account that can hand out money unattended.
       */
      { collection: 'coupon_approvals', action: 'read' },
      { collection: 'coupon_approvals', action: 'update' },
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
      /*
       * The late-order threshold lives in `app_settings`.
       *
       * Missing this grant does NOT fail loudly: the read 403s, the reader's
       * catch falls back to the documented 60, and the queue answers 200 with
       * a threshold operations did not set. Staging showed exactly that —
       * the setting said 20 for several minutes while every response said 60,
       * and nothing anywhere reported a problem.
       *
       * Read-only. A service account that can write settings is one that can
       * change the business rule unattended.
       */
      ...readOnly('app_settings'),
    ],
  },
];
