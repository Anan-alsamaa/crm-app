/**
 * Directus hook: app-roles-sync.
 *
 * The Roles page in the admin portal edits `app_roles` rows — a name, a set of
 * privilege ticks, an optional brand restriction. A row DESCRIBES a role; this
 * extension is what makes it real: on every save it materializes the row into a
 * Directus role + policy + permission set, built from a fixed catalog of
 * permission blocks.
 *
 * Why an extension rather than the portal writing permissions itself: managing
 * `directus_permissions` requires admin_access, and handing an admin token to a
 * browser (or parking one in a gateway env var) widens the blast radius of any
 * portal compromise to the whole permission system. This code runs inside
 * Directus with server-side authority, the portal only ever writes a
 * declarative row, and the ceiling of what a custom role can be granted is the
 * CATALOG below — which contains business permissions only. Nothing here can
 * mint admin_access, touch settings, or edit permissions themselves, no matter
 * what a row claims.
 *
 * Sync is FULL REPLACE: the policy's permissions are rebuilt from the row on
 * every save. Hand-editing a materialized role's permissions in Directus is
 * therefore futile by design — the row is the source of truth, same contract as
 * the bootstrap's roles.ts (whose filter shapes this file mirrors; keep the two
 * in sync when either changes).
 *
 * Built-in roles (Administrator, Admin, Agent, svc-*) are never touched: rows
 * flagged `builtin` are display-only and RESERVED names are refused outright.
 */
export default ({ filter, action }, { services, database, getSchema, logger }) => {
  const { RolesService, PoliciesService, PermissionsService } = services;

  const log = (msg) => logger?.info?.(`app-roles-sync: ${msg}`);
  const warn = (msg) => logger?.warn?.(`app-roles-sync: ${msg}`);

  /**
   * A rejection the API reports as 400, not 500.
   *
   * Directus's error middleware calls `isDirectusError(err)` and answers 500 to
   * anything that fails it — so a plain `new Error('bad input')` thrown from a
   * filter hook tells the caller the SERVER broke when the PAYLOAD was wrong.
   *
   * `isDirectusError` tests for `Symbol.for('directus-error')`, and it must sit
   * on the PROTOTYPE: setting `err[Symbol.for('directus-error')] = true` on the
   * instance is not seen, and neither are `status`/`code` on their own. All
   * three were measured against Directus 11 before this was written.
   *
   * `@directus/errors` is not resolvable from a bare hook (it is bundled inside
   * @directus/api), so the shape is reproduced here rather than imported.
   */
  class ValidationError extends Error {
    constructor(message, code = 'INVALID_PAYLOAD') {
      super(message);
      this.name = 'DirectusError';
      this.code = code;
      this.status = 400;
      this.extensions = {};
    }
  }
  Object.defineProperty(ValidationError.prototype, Symbol.for('directus-error'), {
    value: true,
  });

  /** 403 for "you may not touch this", as distinct from "your input is wrong". */
  class ForbiddenishError extends ValidationError {
    constructor(message) {
      super(message, 'INVALID_PAYLOAD');
      this.status = 403;
    }
  }

  /* ── mirrors of directus/bootstrap/src/roles.ts (keep in sync) ────────── */

  const ASSIGNED_OR_UNASSIGNED = {
    _or: [
      { assigned_agent: { _eq: '$CURRENT_USER' } },
      { assigned_agent: { _null: true } },
      {
        // The _nnull guard is load-bearing: for a team-less viewer,
        // `$CURRENT_USER.team` is null and a bare _eq degenerates into an
        // IS NULL predicate that matches most of the inbox.
        _and: [
          { assigned_team: { _nnull: true } },
          { assigned_team: { _eq: '$CURRENT_USER.team' } },
        ],
      },
    ],
  };
  /*
   * THE SAME THREE WAYS, PLUS: anybody may READ a CLOSED chat (ops,
   * 2026-10-04). Mirrors ASSIGNED_UNASSIGNED_OR_SOLVED in
   * directus/bootstrap/src/roles.ts — `scripts/check-permission-drift.mjs`
   * fails if one moves without the other.
   *
   * Narrower than the widening refused on 2026-09-14: that protected a LIVE
   * thread somebody owns, and a solved chat is finished work with no owner left
   * to respect. An agent still cannot see a colleague's OPEN chat.
   *
   * All three legacy spellings are named. `normaliseConversationStatus`
   * collapses the vocabulary to `open | solved`, but the column has also held
   * `resolved` and `closed` — matching RESUMABLE_STATUSES in the gateway. A
   * filter matching only `solved` would leave older rows invisible, which is
   * the silent empty-result shape this codebase keeps producing.
   */
  const ASSIGNED_UNASSIGNED_OR_SOLVED = {
    _or: [...ASSIGNED_OR_UNASSIGNED._or, { status: { _in: ['solved', 'resolved', 'closed'] } }],
  };
  /* Messages follow their conversation, closed ones included: a history you
     can list but not open is not history. */
  const MESSAGE_OF_VISIBLE_CONVERSATION = { conversation: ASSIGNED_UNASSIGNED_OR_SOLVED };
  const SELF_RECIPIENT = { recipient: { _eq: '$CURRENT_USER' } };
  const OWN_TICKET = { assigned_agent: { _eq: '$CURRENT_USER' } };

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
  ];
  const COUPON_FIELDS = ['coupon_code', 'coupon_value', 'coupon_percent', 'compensation'];
  /*
   * A chat's columns, split by who may change them (owner, 2026-10-06): closing
   * and assigning became their own permissions, so the agent's general update
   * may no longer touch them. These are every column the portals write — the
   * order stamp and the priority; status/solved_at and the two assignee
   * columns now come with close_chats and assign_chats.
   */
  const CONVERSATION_FIELDS_BASE = [
    'priority',
    'last_order_id',
    'last_order_snapshot',
    'last_order_at',
  ];
  const CONVERSATION_FIELDS_CLOSE = ['status', 'solved_at'];
  const CONVERSATION_FIELDS_ASSIGN = ['assigned_agent', 'assigned_team'];
  const ORG_NOTIFICATION_DEFAULTS = { key: { _eq: 'notification_defaults' } };

  /* ── the Administrator's fine-grained permissions ─────────────────────── */

  /*
   * MIRROR of OWNER_PRIVILEGES / OWNER_PRIVILEGE_DEFAULTS in
   * packages/shared-types/src/privileges.ts — a bare hook cannot import it.
   * `privileges-mirror.test.ts` fails if the two disagree.
   *
   * A key nobody has stored takes its DEFAULT: what the role could do before
   * the key existed. So the rows below grant exactly what they granted before,
   * until the owner flips a switch.
   */
  const nameIn =
    (...names) =>
    (_p, role) =>
      names.includes(role);
  const holds = (key) => (p) => p[key] === true;
  const never = () => false;
  const OWNER_PRIVILEGE_DEFAULTS = {
    start_chats: nameIn(
      'administrator',
      'admin',
      'agent',
      'wecare agent',
      'wecare supervisor',
      'wecare admin',
    ),
    // edit_all_tickets carried the whole conversation update before 2026-10-06.
    assign_chats: (p) => p.use_chat === true || p.edit_all_tickets === true,
    close_chats: (p) => p.use_chat === true || p.edit_all_tickets === true,
    bulk_edit_chats: holds('use_chat'),
    delete_chats: never,
    edit_own_messages: holds('use_chat'),
    receive_chats: nameIn('wecare agent', 'wecare supervisor'),
    no_agents_alert: nameIn('wecare supervisor', 'wecare admin', 'administrator'),
    view_contacts: holds('use_chat'),
    create_contacts: holds('use_chat'),
    edit_contacts: holds('use_chat'),
    export_contacts: holds('use_chat'),
    view_ticket_history: nameIn('administrator', 'admin', 'wecare admin', 'wecare supervisor'),
    export_ticket_excel: nameIn('administrator', 'admin'),
    work_late_orders: holds('create_tickets'),
    view_late_orders_report: (p) => p.view_all_tickets === true && p.view_all_chats === true,
    export_late_orders: nameIn('wecare admin', 'wecare supervisor'),
    view_order_details: (_p, role) => role.startsWith('wecare'),
    request_coupons: holds('create_tickets'),
    view_coupon_spend: nameIn('administrator', 'wecare admin', 'wecare supervisor'),
    view_compensation_reports: holds('approve_coupons'),
    delete_compensation: never,
    view_agent_reports: holds('view_all_chats'),
    view_sla_report: (p) => p.view_all_tickets === true && p.view_all_chats === true,
    delete_users: nameIn('administrator', 'wecare admin'),
    manage_teams: holds('manage_users'),
    edit_yiji_branch_id: never,
    manage_store_notifications: holds('manage_restaurants'),
    manage_notification_defaults: never,
  };
  const OWNER_PRIVILEGES = Object.keys(OWNER_PRIVILEGE_DEFAULTS);
  const isOwnerPrivilege = (k) => Object.prototype.hasOwnProperty.call(OWNER_PRIVILEGE_DEFAULTS, k);

  function effectivePrivileges(stored, roleName) {
    const p = { ...(stored ?? {}) };
    const role = String(roleName ?? '')
      .trim()
      .toLowerCase();
    for (const key of OWNER_PRIVILEGES) {
      if (typeof p[key] !== 'boolean') p[key] = OWNER_PRIVILEGE_DEFAULTS[key](p, role);
    }
    return p;
  }
  const STORE_FIELDS_NO_YIJI_ID = [
    'code',
    'name',
    'city',
    'area_manager',
    'chain_manager',
    'brand',
    'status',
  ];

  /* ── grant helpers ────────────────────────────────────────────────────── */

  // filter {} = unrestricted; fields null = all fields.
  const g = (collection, actionName, filterObj = {}, fields = null, validation = null) => ({
    collection,
    action: actionName,
    filter: filterObj,
    fields,
    validation,
  });
  const crud = (c) => ['create', 'read', 'update', 'delete'].map((a) => g(c, a));
  const readOnly = (c) => [g(c, 'read')];

  /** What EVERY app role gets: the reads the portal shell cannot render without. */
  const BASELINE = [
    ...readOnly('vendors'),
    ...readOnly('teams'),
    ...readOnly('brands'),
    ...readOnly('stores'),
    ...readOnly('directus_users'),
    ...readOnly('option_lists'),
    ...readOnly('app_settings'),
    // Its OWN privileges, so the portal can decide what to offer this person.
    // Without this a scoped role signs in, reads nothing back, and is handed
    // either an empty portal or — worse — the whole nav, because "no privileges
    // found" and "no privileges granted" look identical from the client.
    ...readOnly('app_roles'),
    ...readOnly('quick_replies'),
    ...readOnly('routing_events'),
    ...readOnly('directus_files'),
    // Reads the code-defined Agent role always had. Without them a materialized
    // agent role renders a ticket with no deadline and a form with no custom
    // fields — not a 403 anyone reports, just a quieter screen.
    ...readOnly('sla_policies'),
    ...readOnly('custom_fields'),
    ...readOnly('store_notify_rules'),
    ...readOnly('automation_rules'),
    g('notifications', 'read', SELF_RECIPIENT),
    g('notifications', 'update', SELF_RECIPIENT),
    g('directus_users', 'update', { id: { _eq: '$CURRENT_USER' } }, [
      'notification_preferences',
      'locale',
      'first_name',
      'last_name',
    ]),
    g('directus_activity', 'read', { collection: { _eq: 'tickets' } }),
    g('directus_revisions', 'read', { collection: { _eq: 'tickets' } }),
  ];

  /**
   * THE CATALOG. Key = what the Roles page shows a checkbox for; value = the
   * permission blocks that tick grants. Anything not in here cannot be granted
   * through a row, full stop.
   */
  const CATALOG = {
    use_chat: [
      g('conversations', 'create'),
      g('conversations', 'read', ASSIGNED_UNASSIGNED_OR_SOLVED),
      /*
       * UPDATE IS UNSCOPED; READ IS NOT (owner, 2026-09-30).
       *
       * An agent could OPEN a colleague's chat and then not close it. The chat
       * is auto-claimed by whoever replies FIRST, so two agents working at once
       * routinely leaves one holding a thread the other has to finish — and the
       * refusal carried no reason, so it read as a broken button. This is the
       * same fault that blocked supervisors, one tier down.
       *
       * THE READ STAYS SCOPED, and that is what keeps this narrow: an agent
       * still only sees their own chats and unassigned ones, so "any chat" in
       * practice means "any chat they could already open". Widening
       * ASSIGNED_OR_UNASSIGNED itself would have handed them everyone's history,
       * which is a different and much larger change.
       */
      /*
       * AND IT STAYS UNSCOPED THROUGH THE 2026-10-04 WIDENING, deliberately.
       *
       * The reasoning just above depended on the READ being scoped, so opening
       * CLOSED chats to every agent does change what this reaches: every agent
       * can now update any closed conversation.
       *
       * That was raised with the owner and is the ANSWER THEY GAVE: a closed
       * chat opened to all agents must come with "open, send message and all
       * functionalities" — not a read-only archive. `messages.create` is
       * already unscoped, so replying worked either way; scoping this would
       * have left a visible chat whose buttons 403 for no stated reason, the
       * same fault that blocked supervisors.
       *
       * The LIVE scope is untouched: a colleague's OPEN chat is still
       * unreadable, so it cannot be updated either — the read is the gate.
       */
      /* …and since 2026-10-06 only the columns that are not closing or
         assigning a chat, which are close_chats / assign_chats now (still
         unscoped; still gated by the read). */
      g('conversations', 'update', {}, CONVERSATION_FIELDS_BASE),
      g('messages', 'create'),
      g('messages', 'read', MESSAGE_OF_VISIBLE_CONVERSATION),
      /*
       * CREATE, and it was the missing one (owner-approved, 2026-09-29).
       *
       * A WeCare Agent could read and edit a contact but not make one, so the
       * Add-ticket page's "Add <number> as a new customer" button — the whole
       * point of which is the customer we have NOT met, reaching us from another
       * channel — failed with a 403 for exactly the role that uses it most.
       *
       * It read as intermittent because every OTHER role that raises tickets
       * (WeCare Supervisor, WeCare Admin, Department Manager) already had
       * create, so the same button worked for whoever tested it. And the UI
       * catches any failure as "Could not add the customer. Please try again",
       * so an agent retrying failed forever with no hint it was a permission.
       *
       * It belongs to `use_chat` rather than a privilege of its own: creating
       * the contact is not a separate act, it is how a conversation or a ticket
       * with a stranger begins, and every holder of `use_chat` already has
       * `contacts.update` — which is the more dangerous of the two, since it can
       * rewrite somebody who exists.
       */
      /* Creating and editing a customer moved to create_contacts and
         edit_contacts (owner, 2026-10-06); both default to use_chat, so every
         holder keeps them until the owner says otherwise. */
      g('contacts', 'read'),
      g('tags', 'create'),
      g('tags', 'read'),
      g('tags', 'update'),
      g('tags', 'delete'),
      ...crud('conversations_tags'),
      g('messages_files', 'create'),
      g('messages_files', 'read'),
      g('directus_files', 'create'),
      g('csat_responses', 'read'),
      g('custom_field_values', 'create'),
      g('custom_field_values', 'read'),
      g('custom_field_values', 'update'),
      g('contacts_tags', 'read'),
      g('store_notifications', 'create'),
    ],
    view_all_chats: [
      // Wide reads deliberately override the scoped ones from use_chat.
      g('conversations', 'read'),
      g('messages', 'read'),
    ],
    /*
     * `late_order_decisions` rides with the ticket privileges.
     *
     * It was in NO catalog block at all, so no app role could ever reach it —
     * only the legacy `Agent policy` / `Admin policy` carried grants, and every
     * real person is on a WeCare role. So the agent portal's Ignore button
     * answered 403 ("could not save") and the admin portal's Late orders report
     * showed an error, while the drift guard stayed green because it only
     * asserted the two legacy roles (owner, 2026-09-27).
     *
     * Recording a decision is queue work, so it follows the ticket privileges
     * rather than earning one of its own: whoever may work tickets may say what
     * happened to a late order, and whoever may see every ticket may read the
     * report built from those decisions.
     */
    view_tickets: [
      g('tickets', 'read', OWN_TICKET),
      g('ticket_events', 'read'),
      g('tickets_files', 'read'),
      ...readOnly('late_order_decisions'),
    ],
    view_all_tickets: [
      g('tickets', 'read'),
      g('ticket_events', 'read'),
      g('tickets_files', 'read'),
      ...readOnly('late_order_decisions'),
    ],
    create_tickets: [
      g('tickets', 'create'),
      // Deciding a late order (create/update on late_order_decisions) and
      // requesting a coupon (coupon_approvals.create) were here; since
      // 2026-10-06 they are work_late_orders and request_coupons, which
      // default to this privilege.
      g('ticket_events', 'create'),
      g('tickets_files', 'create'),
      g('tickets_files', 'read'),
      g('tickets_files', 'delete'),
      g('directus_files', 'create'),
      // Reads are queue-wide: compensation is worked as a shared pool, so
      // every agent sees every request (one source of truth).
      g('coupon_approvals', 'read'),
    ],
    edit_tickets: [
      g('tickets', 'update', OWN_TICKET, TICKET_FIELDS_AGENT_WRITABLE),
      g('ticket_events', 'create'),
    ],
    edit_all_tickets: [
      g('tickets', 'update', {}, TICKET_FIELDS_AGENT_WRITABLE),
      g('ticket_events', 'create'),
      /*
       * AND ANY CHAT, NOT ONLY ANY TICKET (owner, 2026-09-30).
       *
       * A supervisor could OPEN every conversation (`view_all_chats` grants a
       * wide read) and then not close one: `use_chat`'s update is scoped to
       * mine-or-unassigned, and a chat is auto-claimed by whoever replies
       * first. So Mohamed - a WeCare Supervisor - solved the ticket, pressed
       * Close this chat and was refused, while the owner could do it because
       * `Admin policy` is unscoped. Read everything, change nothing is not a
       * supervisor.
       *
       * It rides with `edit_all_tickets` rather than `view_all_chats` because
       * that privilege already means "act on work that is not yours", and
       * `view_all_chats` is held by VIEWER - who must keep reading without
       * gaining the ability to close other people's chats.
       *
       * Unscoped `{}` deliberately: the whole point is a chat somebody else
       * owns. The narrower grant from `use_chat` stays; Directus ORs them, so
       * an agent is unaffected.
       */
      /* The general columns only; closing and assigning a chat are their own
         permissions since 2026-10-06 (both unscoped, like this). */
      g('conversations', 'update', {}, CONVERSATION_FIELDS_BASE),
    ],
    delete_tickets: [g('tickets', 'delete')],
    approve_coupons: [
      g('coupon_approvals', 'read'),
      g('coupon_approvals', 'update'),
      // Approving WRITES the coupon onto the ticket — the only path that may
      // touch these columns. The agent-writable field list excludes them.
      g('tickets', 'update', {}, COUPON_FIELDS),
    ],
    view_dashboard: [
      // Dashboards aggregate over everything, so this is read-wide by nature —
      // the same trade the ops portal's Viewer role makes.
      g('tickets', 'read'),
      g('conversations', 'read'),
      g('messages', 'read'),
      g('contacts', 'read'),
      g('csat_responses', 'read'),
      g('ticket_events', 'read'),
    ],
    export_data: [], // UI gate only: you can export whatever you can already read.
    import_data: [
      g('tickets', 'create'),
      g('ticket_events', 'create'),
      g('contacts', 'create'),
      g('contacts', 'read'),
      g('contacts', 'update'),
    ],
    /*
     * The dropdown lists, the app settings — and the inbox's ready replies.
     *
     * `quick_replies` was in BASELINE as readOnly and NOWHERE else, so no
     * privilege could ever grant a write to it: every role could see the ready
     * replies and none could change one. The admin portal offered the editor
     * anyway, so the page rendered its buttons and every save came back
     * "Couldn't save your change".
     *
     * It was granted by hand twice, and both times the next save of any role
     * re-materialized that role's policy from this CATALOG and reset the
     * collection to read-only — the grant looked applied and then quietly
     * vanished. A permission the product needs has to be declared HERE or it
     * does not survive (owner, 2026-09-24).
     *
     * Same privilege as the dropdown values because it is the same job, done
     * from the same page, by the same person.
     */
    manage_lists: [...crud('option_lists'), ...crud('app_settings'), ...crud('quick_replies')],
    manage_restaurants: [
      ...crud('brands'),
      g('stores', 'read'),
      g('stores', 'delete'),
      g('stores', 'create', {}, STORE_FIELDS_NO_YIJI_ID),
      g('stores', 'update', {}, STORE_FIELDS_NO_YIJI_ID),
    ],
    // Delete is delete_users since 2026-10-06 — the Users page only ever
    // offered it to the Administrator and WeCare Admin, and that is its default.
    manage_users: ['create', 'read', 'update'].map((a) => g('directus_users', a)),
    // UI gate: the Operations tab of the dashboard. Its reads arrive with
    // view_dashboard / view_all_tickets.
    view_ops_dashboard: [],
    schedule_reports: [...crud('reports')],
    manage_sla: [...crud('sla_policies')],
    // The Roles editor. Reads directus_roles so the page can show which
    // Directus role a row materialized to. What a holder may GRANT is capped
    // by enforceCeiling below, not by this block.
    manage_roles: [...crud('app_roles'), ...readOnly('directus_roles')],
    // UI gate: the self-serve JSON backup reads through the other privileges.
    manage_backup: [],
    /*
     * The Directus admin app, for a manager who works the data directly.
     *
     * app_access is already on every materialized policy, so signing in was
     * never the missing piece — these are the SCHEMA reads that make the app
     * legible: without them the collection list renders raw keys and the item
     * forms have no field labels.
     *
     * Deliberately absent: directus_permissions, directus_policies,
     * directus_roles, directus_settings. That is the line. A holder has the
     * run of the business data and still cannot re-draw who may see what,
     * because admin_access is not expressible here at all.
     */
    use_directus_app: [
      ...readOnly('directus_collections'),
      ...readOnly('directus_fields'),
      ...readOnly('directus_relations'),
      ...readOnly('directus_translations'),
      ...readOnly('directus_presets'),
    ],

    /* ── the Administrator's fine-grained permissions (owner, 2026-10-06) ──
       `[]` = decided by the portal or a service (the gateway, the workers),
       because the data it reads is already granted elsewhere. */
    start_chats: [], // the gateway's /chat/agent-initiate
    assign_chats: [g('conversations', 'update', {}, CONVERSATION_FIELDS_ASSIGN)],
    close_chats: [g('conversations', 'update', {}, CONVERSATION_FIELDS_CLOSE)],
    bulk_edit_chats: [],
    // Messages, files and tags cascade from the conversation row.
    delete_chats: [g('conversations', 'delete')],
    edit_own_messages: [], // the gateway's message edit/delete
    receive_chats: [], // the gateway's presence + the workers' routing
    no_agents_alert: [], // the workers' alert
    view_contacts: [],
    create_contacts: [g('contacts', 'create')],
    edit_contacts: [
      g('contacts', 'update'),
      g('contacts_tags', 'create'),
      g('contacts_tags', 'delete'),
    ],
    export_contacts: [],
    view_ticket_history: [],
    export_ticket_excel: [],
    work_late_orders: [g('late_order_decisions', 'create'), g('late_order_decisions', 'update')],
    view_late_orders_report: [...readOnly('late_order_decisions')],
    export_late_orders: [],
    view_order_details: [],
    request_coupons: [g('coupon_approvals', 'create'), g('coupon_approvals', 'read')],
    view_coupon_spend: [],
    view_compensation_reports: [g('coupon_approvals', 'read')],
    delete_compensation: [g('coupon_approvals', 'delete')],
    view_agent_reports: [],
    view_sla_report: [],
    delete_users: [g('directus_users', 'delete')],
    manage_teams: [...crud('teams')],
    edit_yiji_branch_id: [g('stores', 'update', {}, ['yiji_restaurant_id'])],
    manage_store_notifications: [...crud('store_notify_rules')],
    manage_notification_defaults: [
      g('app_settings', 'create', {}, null, ORG_NOTIFICATION_DEFAULTS),
      g('app_settings', 'update', ORG_NOTIFICATION_DEFAULTS),
    ],
  };

  const RESERVED = new Set(['administrator', 'admin', 'agent']);
  const isReserved = (name) =>
    RESERVED.has(
      String(name ?? '')
        .trim()
        .toLowerCase(),
    ) ||
    String(name ?? '')
      .trim()
      .toLowerCase()
      .startsWith('svc-');

  /* ── grant merging ────────────────────────────────────────────────────── */

  const isWide = (f) => !f || Object.keys(f).length === 0;

  /**
   * Grants are emitted as SEPARATE permission rows, never merged.
   *
   * Directus permissions are additive: an action on an item is allowed by the
   * union of the rows whose filters match it, and the writable fields are the
   * union of THOSE rows' fields. That is exactly the semantics the privilege
   * matrix promises — and it is not reproducible in one row. The first version
   * of this file merged rows (widest filter + union of fields), which turned
   * edit_tickets (own tickets, most fields) + approve_coupons (any ticket,
   * coupon fields) into "any ticket, most fields": a silent over-grant the
   * moment two privileges touched the same action. Rows stay separate so a
   * scope can never widen a neighbouring grant's fields.
   *
   * Only EXACT duplicates are dropped (several privileges legitimately repeat
   * the same read), purely to keep the permission table readable.
   */
  /**
   * Roles nobody may hand out or take over through manage_users.
   *
   * `manage_users` used to be plain CRUD on directus_users, which meant anyone
   * holding it could PATCH another user's `role` to Administrator — or their
   * own — and become the owner. The fence: a role whose policy carries
   * admin_access, and every service account role, is excluded both as a
   * VALUE (validation: you cannot set it) and as a TARGET (filter: you cannot
   * edit or delete a user who already holds it). Read at sync time so it
   * follows whatever the roles currently are.
   */
  async function protectedRoleIds() {
    const admin = await database('directus_roles as r')
      .join('directus_access as a', 'a.role', 'r.id')
      .join('directus_policies as p', 'p.id', 'a.policy')
      .where('p.admin_access', true)
      .distinct('r.id')
      .pluck('r.id');
    const svc = await database('directus_roles').whereRaw("LOWER(name) LIKE 'svc-%'").pluck('id');
    return Array.from(new Set([...admin, ...svc]));
  }

  function buildGrants(privileges, brandIds, storeIds, protectedRoles = []) {
    const grants = [];
    const seen = new Set();
    const add = (grant) => {
      const sig = JSON.stringify([grant.collection, grant.action, grant.filter, grant.fields]);
      if (seen.has(sig)) return;
      seen.add(sig);
      // Clone so the brand wrap below never mutates the shared CATALOG blocks.
      grants.push({ ...grant, filter: grant.filter });
    };
    BASELINE.forEach(add);
    for (const [priv, on] of Object.entries(privileges ?? {})) {
      if (!on) continue;
      const blocks = CATALOG[priv];
      if (!blocks) {
        warn(`unknown privilege '${priv}' ignored`);
        continue;
      }
      blocks.forEach(add);
    }

    if (protectedRoles.length > 0) {
      const notProtected = { role: { _nin: protectedRoles } };
      for (const grant of grants) {
        if (grant.collection !== 'directus_users') continue;
        if (grant.action === 'create' || grant.action === 'update') {
          grant.validation = notProtected;
        }
        if (grant.action === 'update' || grant.action === 'delete') {
          grant.filter = isWide(grant.filter)
            ? notProtected
            : { _and: [grant.filter, notProtected] };
        }
      }
    }

    /**
     * Brand restriction, applied AFTER the union so it cannot be widened away.
     * Tickets reach a brand through their store; a ticket with no store yet is
     * left visible — hiding every unattributed complaint from a brand
     * supervisor reads as data loss, and it exposes nothing brand-specific.
     * Conversations CANNOT be brand-scoped (no brand column) — the Roles page
     * says so next to the brand picker rather than pretending otherwise.
     */
    if (Array.isArray(brandIds) && brandIds.length > 0) {
      const brandWrap = {
        _or: [{ store: { brand: { _in: brandIds } } }, { store: { _null: true } }],
      };
      for (const grant of grants) {
        const collection = grant.collection;
        if (collection === 'tickets') {
          grant.filter = isWide(grant.filter) ? brandWrap : { _and: [grant.filter, brandWrap] };
        } else if (collection === 'stores' && grant.action === 'read') {
          grant.filter = { brand: { _in: brandIds } };
        } else if (collection === 'brands' && grant.action === 'read') {
          grant.filter = { id: { _in: brandIds } };
        }
      }
    }

    /**
     * Branch restriction — the same shape as the brand one, one level down,
     * and applied AFTER it so the two INTERSECT rather than compete: an area
     * manager fenced to a brand and to three of its branches sees those three,
     * not the brand.
     *
     * Unattributed tickets stay visible for the reason they do above: a
     * complaint that has not been pinned to a branch yet is nobody's secret,
     * and hiding it reads as data loss to the person expected to chase it.
     */
    if (Array.isArray(storeIds) && storeIds.length > 0) {
      const storeWrap = {
        _or: [{ store: { _in: storeIds } }, { store: { _null: true } }],
      };
      for (const grant of grants) {
        const collection = grant.collection;
        if (collection === 'tickets') {
          grant.filter = isWide(grant.filter) ? storeWrap : { _and: [grant.filter, storeWrap] };
        } else if (collection === 'stores' && grant.action === 'read') {
          const only = { id: { _in: storeIds } };
          grant.filter = isWide(grant.filter) ? only : { _and: [grant.filter, only] };
        }
      }
    }
    return grants;
  }

  /* ── row plumbing ─────────────────────────────────────────────────────── */

  /**
   * Sentinel for "a string was supplied that is not JSON at all".
   *
   * Returning null there would be indistinguishable from "absent", and the
   * validator treats absent as "nothing to check" — so a value like `"nope"`
   * sailed past validation and reached Postgres, which rejected it as invalid
   * json syntax and surfaced a raw SQL string as a 500. The validator now
   * refuses this sentinel with a 400 instead.
   */
  const UNPARSEABLE = Symbol('unparseable-json');

  const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return UNPARSEABLE;
      }
    }
    return v;
  };

  /** Stored rows are written by this hook, so an unparseable value there is a
   *  corrupt row rather than user input — treat it as absent. */
  const asStored = (v) => (v === UNPARSEABLE ? null : v);

  async function loadRow(id) {
    const row = await database('app_roles').where({ id }).first();
    if (!row) return null;
    return {
      ...row,
      privileges: asStored(parseJson(row.privileges)),
      brands: asStored(parseJson(row.brands)),
      stores: asStored(parseJson(row.stores)),
      builtin: row.builtin === true || row.builtin === 1,
    };
  }

  /*
   * ONE MATERIALIZE AT A TIME, PER ROLE.
   *
   * The sync below is delete-then-recreate. That is only correct if it never
   * overlaps with itself: two saves of the same role in quick succession each
   * read the "stale" set BEFORE the other has finished creating, so each
   * deletes an old batch and appends a new one. The role ends up holding the
   * rule several times over.
   *
   * Observed on production 2026-09-22: four rapid saves of Area Manager left
   * 116 permission rows where 29 were correct, including EIGHT `tickets.read`
   * rules. Directus permissions are additive, so the widest of the duplicates
   * wins and a role can quietly end up seeing more than its rule allows —
   * which is the dangerous half, worse than the clutter.
   *
   * Chained per rowId rather than globally, so saving two different roles at
   * once is still parallel. The entry is dropped once it settles, so the map
   * cannot grow without bound.
   */
  const inFlight = new Map();

  function materialize(rowId) {
    const prior = inFlight.get(rowId) ?? Promise.resolve();
    /* `.catch` so one failed save does not poison every later save of the same
       role — the chain continues, and the error still reaches the caller. */
    const next = prior.catch(() => {}).then(() => materializeNow(rowId));
    inFlight.set(rowId, next);
    void next.finally(() => {
      if (inFlight.get(rowId) === next) inFlight.delete(rowId);
    });
    return next;
  }

  async function materializeNow(rowId) {
    const row = await loadRow(rowId);
    if (!row) return;
    if (row.builtin) {
      log(`skip builtin row '${row.name}'`);
      return;
    }
    if (isReserved(row.name)) {
      warn(`refused reserved name '${row.name}'`);
      return;
    }

    const schema = await getSchema();
    const opts = { schema, accountability: null, knex: database };
    const rolesService = new RolesService(opts);
    const policiesService = new PoliciesService(opts);
    const permissionsService = new PermissionsService(opts);

    // Role: reuse the written-back id when it still exists, else find-or-create
    // by name so a re-seeded database converges instead of duplicating.
    let roleId = row.directus_role;
    if (roleId) {
      const exists = await database('directus_roles').where({ id: roleId }).first();
      if (!exists) roleId = null;
    }
    if (!roleId) {
      const byName = await database('directus_roles')
        .whereRaw('LOWER(name) = ?', [row.name.toLowerCase()])
        .first();
      roleId = byName
        ? byName.id
        : await rolesService.createOne({
            name: row.name,
            icon: 'verified_user',
            description: row.description ?? null,
          });
    } else if (row.name) {
      await rolesService.updateOne(roleId, {
        name: row.name,
        description: row.description ?? null,
      });
    }

    // Policy, same convergence rules.
    const policyName = `app-role: ${row.name}`;
    let policyId = row.directus_policy;
    if (policyId) {
      const exists = await database('directus_policies').where({ id: policyId }).first();
      if (!exists) policyId = null;
    }
    if (!policyId) {
      const byName = await database('directus_policies').where({ name: policyName }).first();
      policyId = byName
        ? byName.id
        : await policiesService.createOne({
            name: policyName,
            icon: 'badge',
            app_access: true,
            admin_access: false,
            description:
              'Materialized from app_roles — do not edit by hand; the next sync replaces it.',
          });
    } else {
      // The policy carries app_access and MUST NEVER carry admin_access; assert
      // it on every sync rather than trusting whatever it drifted to.
      await policiesService.updateOne(policyId, {
        name: policyName,
        app_access: true,
        admin_access: false,
      });
    }

    const link = await database('directus_access')
      .where({ role: roleId, policy: policyId })
      .first();
    if (!link) {
      const { randomUUID } = await import('node:crypto');
      await database('directus_access').insert({
        id: randomUUID(),
        role: roleId,
        policy: policyId,
        sort: 1,
      });
    }

    /*
     * Full replace, via the service so Directus's permission cache is flushed.
     *
     * This is also the SELF-HEAL for duplicates: every row on the policy goes,
     * whatever put it there, so a role that somehow accumulated the same rule
     * several times is back to one set after any save. Paired with the
     * per-role serialization above, which stops them accumulating at all.
     */
    /*
     * CREATE FIRST, DELETE LAST — and never both when nothing changed.
     *
     * This used to delete every row on the policy and then re-create the full
     * set. It emptied a live role on both environments: the delete of ~90 rows
     * logged its warning, the PATCH answered 200, and `createMany` never ran —
     * so the policy sat at ZERO permissions and no amount of re-saving
     * recovered it, because each retry deleted the (already empty) set and died
     * in the same place. Nothing was logged, because nothing threw: the request
     * had already returned and the work was torn down mid-function.
     *
     * A role with no permissions is the worst possible failure here — everyone
     * holding it loses the whole portal — so the write order now makes the
     * dangerous half last and skips it entirely when the policy already
     * matches. Inserting a duplicate is survivable (Directus permissions are
     * additive, and the sweep below removes it next time); deleting everything
     * is not (owner, 2026-09-24).
     */
    // EFFECTIVE, not stored: a fine-grained key nobody has set grants what its
    // default says, which is what the role could already do.
    const grants = buildGrants(
      effectivePrivileges(row.privileges, row.name),
      row.brands,
      row.stores,
      await protectedRoleIds(),
    );
    const desired = grants.map((grant) => ({
      policy: policyId,
      collection: grant.collection,
      action: grant.action,
      permissions: grant.filter && Object.keys(grant.filter).length ? grant.filter : {},
      validation: grant.validation ?? {},
      fields: grant.fields ?? ['*'],
    }));
    /** What identifies a rule, so an unchanged one is left exactly where it is. */
    const sigOf = (p) =>
      JSON.stringify([
        p.collection,
        p.action,
        p.permissions ?? {},
        p.validation ?? {},
        p.fields ?? ['*'],
      ]);

    const existing = await permissionsService.readByQuery({
      filter: { policy: { _eq: policyId } },
      limit: -1,
      fields: ['id', 'collection', 'action', 'permissions', 'validation', 'fields'],
    });
    const keep = new Map();
    const surplus = [];
    // `perm`, not `row`: `row` is the app_roles row this whole function is
    // about, and shadowing it here would put the wrong name in the log below.
    for (const perm of existing) {
      const sig = sigOf(perm);
      // The first occurrence of a rule is kept; any repeat is a duplicate from
      // an older concurrent save and is swept away below.
      if (keep.has(sig)) surplus.push(perm.id);
      else keep.set(sig, perm.id);
    }

    const missing = desired.filter((d) => !keep.has(sigOf(d)));
    if (missing.length) await permissionsService.createMany(missing);

    // Anything the catalog no longer asks for, plus the duplicates. Deleted
    // only AFTER the additions are safely in.
    const wanted = new Set(desired.map(sigOf));
    for (const [sig, id] of keep) if (!wanted.has(sig)) surplus.push(id);
    if (surplus.length) {
      await permissionsService.deleteMany(surplus);
      if (surplus.length > 80) {
        log(`WARNING: '${row.name}' held ${surplus.length} surplus permission rows — cleared`);
      }
    }

    // Write-back with knex, NOT ItemsService: a service update would re-fire
    // this very hook and loop.
    await database('app_roles').where({ id: rowId }).update({
      directus_role: roleId,
      directus_policy: policyId,
    });
    log(`materialized '${row.name}': role ${roleId}, ${grants.length} permissions`);
  }

  /* ── validation (before write) ────────────────────────────────────────── */

  function validatePayload(payload) {
    if (payload.name !== undefined && isReserved(payload.name)) {
      throw new ValidationError(
        `'${payload.name}' is a reserved role name — the built-in roles are defined in code.`,
      );
    }
    const privs = parseJson(payload.privileges);
    if (privs !== null && privs !== undefined) {
      if (privs === UNPARSEABLE || typeof privs !== 'object' || Array.isArray(privs)) {
        throw new ValidationError('privileges must be an object of { privilege: boolean }');
      }
      // Unknown keys are REFUSED, not stripped. Stripping was the original
      // rule — "a crafted payload cannot smuggle a privilege the catalog will
      // only grow to support later" — and it was right about smuggling and
      // wrong about what happens next: a PATCH whose privileges are ALL
      // unknown stripped down to `{}`, which Directus then stored, replacing
      // the whole map. A non-owner sending `{ admin_access: true }` did not
      // gain admin_access; it silently zeroed a Supervisor role instead. A
      // payload that names something outside the catalog is a payload that
      // does not know what it is doing, and it must not be allowed to write.
      const unknown = Object.keys(privs).filter((k) => !CATALOG[k]);
      if (unknown.length) {
        throw new ValidationError(
          `unknown privilege(s): ${unknown.join(', ')} — nothing outside the catalog can be granted`,
        );
      }
      const clean = {};
      for (const k of Object.keys(privs)) clean[k] = Boolean(privs[k]);
      payload.privileges = clean;
    }
    const brands = parseJson(payload.brands);
    if (brands !== null && brands !== undefined && !Array.isArray(brands)) {
      throw new ValidationError('brands must be an array of brand ids');
    }
    const stores = parseJson(payload.stores);
    if (stores !== null && stores !== undefined && !Array.isArray(stores)) {
      throw new ValidationError('stores must be an array of branch ids');
    }
    return payload;
  }

  /**
   * THE CEILING. A non-owner may edit roles only within what they hold.
   *
   * The Roles page disables the toggles a person cannot grant, but a page is
   * not a boundary — a crafted PATCH is. So the same three rules run here, on
   * the caller's accountability, for anyone who is not the Directus owner:
   *
   *   1. they must hold manage_roles themselves;
   *   2. they may not grant a privilege their own role does not hold;
   *   3. they may not edit or delete the role they are signed in with.
   *
   * Together with the CATALOG (which cannot express admin_access, vendors or
   * AI settings at all) this is what keeps the owner's capabilities the
   * owner's: nothing on this list reaches them, and the list is all a role
   * editor can touch.
   */
  /**
   * THE FINE-GRAINED KEYS ARE THE OWNER'S TO SET (owner, 2026-10-06).
   *
   * Everyone else who can open the Roles page sees only the shared list, so a
   * save from them must neither set these keys nor wipe them: `privileges` is
   * one JSON column, and a PATCH replaces it whole — a WeCare Admin saving a
   * role would otherwise erase every switch the owner had set on it.
   *
   * So for a non-owner: whatever they sent for these keys is dropped, and on an
   * update the stored values are carried over untouched.
   */
  async function keepOwnerPrivileges(payload, context, keys = []) {
    const acc = context?.accountability;
    if (!acc || acc.admin || !payload?.privileges) return payload;
    // One shared map cannot carry several rows' stored keys; the page never
    // sends a batch, so refuse rather than wipe.
    if (keys.length > 1) {
      throw new ValidationError('Save roles one at a time.');
    }
    const next = {};
    for (const [k, v] of Object.entries(payload.privileges)) {
      if (!isOwnerPrivilege(k)) next[k] = v;
    }
    if (keys.length === 1) {
      const row = await loadRow(keys[0]);
      for (const [k, v] of Object.entries(row?.privileges ?? {})) {
        if (isOwnerPrivilege(k) && typeof v === 'boolean') next[k] = v;
      }
    }
    payload.privileges = next;
    return payload;
  }

  async function enforceCeiling(payload, context, keys = []) {
    const acc = context?.accountability;
    if (!acc || acc.admin) return payload; // the owner is unrestricted
    if (!acc.role) throw new ForbiddenishError('No role on this session.');
    const mine = await database('app_roles').where({ directus_role: acc.role }).first();
    const held = parseJson(mine?.privileges) ?? {};
    if (!held.manage_roles) {
      throw new ForbiddenishError('Your role does not include managing roles.');
    }
    for (const key of keys) {
      const row = await loadRow(key);
      if (row?.directus_role && row.directus_role === acc.role) {
        throw new ForbiddenishError(
          'You cannot change the role you are signed in with. Ask the project owner.',
        );
      }
    }
    if (payload && payload.privileges) {
      for (const [k, on] of Object.entries(payload.privileges)) {
        // Owner keys here are the stored ones carried over, not a grant.
        if (isOwnerPrivilege(k)) continue;
        if (on && !held[k]) {
          throw new ForbiddenishError(`You cannot grant '${k}' — your own role does not hold it.`);
        }
      }
    }
    return payload;
  }

  filter('app_roles.items.create', async (payload, _meta, context) =>
    enforceCeiling(await keepOwnerPrivileges(validatePayload(payload), context), context),
  );
  filter('app_roles.items.update', async (payload, meta, context) => {
    // A builtin row is display-only. Refuse edits to anything but description.
    for (const key of meta.keys ?? []) {
      const row = await loadRow(key);
      if (row?.builtin) {
        const touched = Object.keys(payload).filter((k) => !['description'].includes(k));
        if (touched.length)
          throw new ForbiddenishError(
            `'${row.name}' is a built-in role — it is defined in code, not here.`,
          );
      }
    }
    return enforceCeiling(
      await keepOwnerPrivileges(validatePayload(payload), context, meta.keys ?? []),
      context,
      meta.keys ?? [],
    );
  });

  // Deleting a row tears the materialized artifacts down BEFORE the row goes,
  // while we can still read which role/policy it owned.
  filter('app_roles.items.delete', async (keys, _meta, context) => {
    await enforceCeiling(null, context, keys);
    for (const key of keys) {
      const row = await loadRow(key);
      if (!row) continue;
      if (row.builtin)
        throw new ForbiddenishError(`'${row.name}' is a built-in role and cannot be deleted.`);
      const schema = await getSchema();
      const opts = { schema, accountability: null, knex: database };
      try {
        if (row.directus_policy) {
          const permissionsService = new PermissionsService(opts);
          const stale = await permissionsService.readByQuery({
            filter: { policy: { _eq: row.directus_policy } },
            limit: -1,
            fields: ['id'],
          });
          if (stale.length) await permissionsService.deleteMany(stale.map((p) => p.id));
          await database('directus_access').where({ policy: row.directus_policy }).del();
          await new PoliciesService(opts).deleteOne(row.directus_policy);
        }
        if (row.directus_role) {
          // Throws while users still hold the role — exactly right: reassign
          // people first, then delete. The portal surfaces the message.
          await new RolesService(opts).deleteOne(row.directus_role);
        }
        log(`tore down materialized role for '${row.name}'`);
      } catch (err) {
        const conflict = new ValidationError(
          `Cannot delete '${row.name}': ${err?.message ?? err}. Reassign its users to another role first.`,
        );
        // A role still in use is a CONFLICT, not malformed input.
        conflict.status = 409;
        throw conflict;
      }
    }
    return keys;
  });

  action('app_roles.items.create', async (meta) => {
    try {
      await materialize(meta.key);
    } catch (err) {
      warn(`materialize failed: ${err?.message ?? err}`);
    }
  });
  action('app_roles.items.update', async (meta) => {
    for (const key of meta.keys ?? []) {
      try {
        await materialize(key);
      } catch (err) {
        warn(`materialize failed: ${err?.message ?? err}`);
      }
    }
  });
};
