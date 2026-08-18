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
  const MESSAGE_OF_VISIBLE_CONVERSATION = { conversation: ASSIGNED_OR_UNASSIGNED };
  const SELF_RECIPIENT = { recipient: { _eq: '$CURRENT_USER' } };
  const OWN_TICKET = { assigned_agent: { _eq: '$CURRENT_USER' } };

  const TICKET_FIELDS_AGENT_WRITABLE = [
    'subject', 'description', 'status', 'priority',
    'first_responded_at', 'resolved_at', 'closed_at',
    'assigned_agent', 'assigned_team', 'store',
    'complaint_date', 'complaint_type', 'service_type', 'complaint_source',
    'communication_method', 'response_desc', 'compensation',
  ];
  const COUPON_FIELDS = ['coupon_code', 'coupon_value', 'coupon_percent', 'compensation'];
  const STORE_FIELDS_NO_YIJI_ID = [
    'code', 'name', 'city', 'area_manager', 'chain_manager', 'brand', 'status',
  ];

  /* ── grant helpers ────────────────────────────────────────────────────── */

  // filter {} = unrestricted; fields null = all fields.
  const g = (collection, actionName, filterObj = {}, fields = null) => ({
    collection, action: actionName, filter: filterObj, fields,
  });
  const crud = (c) => ['create', 'read', 'update', 'delete'].map((a) => g(c, a));
  const readOnly = (c) => [g(c, 'read')];

  /** What EVERY app role gets: the reads the portal shell cannot render without. */
  const BASELINE = [
    ...readOnly('vendors'), ...readOnly('teams'), ...readOnly('brands'),
    ...readOnly('stores'), ...readOnly('directus_users'),
    ...readOnly('option_lists'), ...readOnly('app_settings'),
    ...readOnly('quick_replies'), ...readOnly('routing_events'),
    ...readOnly('directus_files'),
    g('notifications', 'read', SELF_RECIPIENT),
    g('notifications', 'update', SELF_RECIPIENT),
    g('directus_users', 'update', { id: { _eq: '$CURRENT_USER' } },
      ['notification_preferences', 'locale', 'first_name', 'last_name']),
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
      g('conversations', 'read', ASSIGNED_OR_UNASSIGNED),
      g('conversations', 'update', ASSIGNED_OR_UNASSIGNED),
      g('messages', 'create'),
      g('messages', 'read', MESSAGE_OF_VISIBLE_CONVERSATION),
      g('contacts', 'read'), g('contacts', 'update'),
      g('tags', 'create'), g('tags', 'read'), g('tags', 'update'), g('tags', 'delete'),
      ...crud('conversations_tags'),
      g('messages_files', 'create'), g('messages_files', 'read'),
      g('directus_files', 'create'),
      g('csat_responses', 'read'),
    ],
    view_all_chats: [
      // Wide reads deliberately override the scoped ones from use_chat.
      g('conversations', 'read'), g('messages', 'read'),
    ],
    view_tickets: [
      g('tickets', 'read', OWN_TICKET),
      g('ticket_events', 'read'),
      g('tickets_files', 'read'),
    ],
    view_all_tickets: [g('tickets', 'read'), g('ticket_events', 'read'), g('tickets_files', 'read')],
    create_tickets: [
      g('tickets', 'create'),
      g('ticket_events', 'create'),
      g('tickets_files', 'create'), g('tickets_files', 'read'), g('tickets_files', 'delete'),
      g('directus_files', 'create'),
      // Requesting a coupon is part of raising a ticket; DECIDING one is
      // approve_coupons. Reads are queue-wide: compensation is worked as a
      // shared pool, so every agent sees every request (one source of truth).
      g('coupon_approvals', 'create'),
      g('coupon_approvals', 'read'),
    ],
    edit_tickets: [
      g('tickets', 'update', OWN_TICKET, TICKET_FIELDS_AGENT_WRITABLE),
      g('ticket_events', 'create'),
    ],
    edit_all_tickets: [
      g('tickets', 'update', {}, TICKET_FIELDS_AGENT_WRITABLE),
      g('ticket_events', 'create'),
    ],
    delete_tickets: [g('tickets', 'delete')],
    approve_coupons: [
      g('coupon_approvals', 'read'), g('coupon_approvals', 'update'),
      // Approving WRITES the coupon onto the ticket — the only path that may
      // touch these columns. The agent-writable field list excludes them.
      g('tickets', 'update', {}, COUPON_FIELDS),
    ],
    view_dashboard: [
      // Dashboards aggregate over everything, so this is read-wide by nature —
      // the same trade the ops portal's Viewer role makes.
      g('tickets', 'read'), g('conversations', 'read'), g('messages', 'read'),
      g('contacts', 'read'), g('csat_responses', 'read'), g('ticket_events', 'read'),
    ],
    export_data: [], // UI gate only: you can export whatever you can already read.
    import_data: [
      g('tickets', 'create'), g('ticket_events', 'create'),
      g('contacts', 'create'), g('contacts', 'read'), g('contacts', 'update'),
    ],
    manage_lists: [...crud('option_lists'), ...crud('app_settings')],
    manage_restaurants: [
      ...crud('brands'),
      g('stores', 'read'), g('stores', 'delete'),
      g('stores', 'create', {}, STORE_FIELDS_NO_YIJI_ID),
      g('stores', 'update', {}, STORE_FIELDS_NO_YIJI_ID),
    ],
    manage_users: [...crud('directus_users')],
  };

  const RESERVED = new Set(['administrator', 'admin', 'agent']);
  const isReserved = (name) =>
    RESERVED.has(String(name ?? '').trim().toLowerCase()) ||
    String(name ?? '').trim().toLowerCase().startsWith('svc-');

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
  function buildGrants(privileges, brandIds) {
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
      if (!blocks) { warn(`unknown privilege '${priv}' ignored`); continue; }
      blocks.forEach(add);
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
    return grants;
  }

  /* ── row plumbing ─────────────────────────────────────────────────────── */

  const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  };

  async function loadRow(id) {
    const row = await database('app_roles').where({ id }).first();
    if (!row) return null;
    return {
      ...row,
      privileges: parseJson(row.privileges),
      brands: parseJson(row.brands),
      builtin: row.builtin === true || row.builtin === 1,
    };
  }

  async function materialize(rowId) {
    const row = await loadRow(rowId);
    if (!row) return;
    if (row.builtin) { log(`skip builtin row '${row.name}'`); return; }
    if (isReserved(row.name)) { warn(`refused reserved name '${row.name}'`); return; }

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
      const byName = await database('directus_roles').whereRaw('LOWER(name) = ?', [row.name.toLowerCase()]).first();
      roleId = byName
        ? byName.id
        : await rolesService.createOne({ name: row.name, icon: 'verified_user', description: row.description ?? null });
    } else if (row.name) {
      await rolesService.updateOne(roleId, { name: row.name, description: row.description ?? null });
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
            name: policyName, icon: 'badge', app_access: true, admin_access: false,
            description: 'Materialized from app_roles — do not edit by hand; the next sync replaces it.',
          });
    } else {
      // The policy carries app_access and MUST NEVER carry admin_access; assert
      // it on every sync rather than trusting whatever it drifted to.
      await policiesService.updateOne(policyId, { name: policyName, app_access: true, admin_access: false });
    }

    const link = await database('directus_access').where({ role: roleId, policy: policyId }).first();
    if (!link) {
      const { randomUUID } = await import('node:crypto');
      await database('directus_access').insert({ id: randomUUID(), role: roleId, policy: policyId, sort: 1 });
    }

    // Full replace, via the service so Directus's permission cache is flushed.
    const stale = await permissionsService.readByQuery({
      filter: { policy: { _eq: policyId } }, limit: -1, fields: ['id'],
    });
    if (stale.length) await permissionsService.deleteMany(stale.map((p) => p.id));

    const grants = buildGrants(row.privileges, row.brands);
    await permissionsService.createMany(grants.map((grant) => ({
      policy: policyId,
      collection: grant.collection,
      action: grant.action,
      permissions: grant.filter && Object.keys(grant.filter).length ? grant.filter : {},
      validation: {},
      fields: grant.fields ?? ['*'],
    })));

    // Write-back with knex, NOT ItemsService: a service update would re-fire
    // this very hook and loop.
    await database('app_roles').where({ id: rowId }).update({
      directus_role: roleId, directus_policy: policyId,
    });
    log(`materialized '${row.name}': role ${roleId}, ${grants.length} permissions`);
  }

  /* ── validation (before write) ────────────────────────────────────────── */

  function validatePayload(payload) {
    if (payload.name !== undefined && isReserved(payload.name)) {
      throw new Error(`'${payload.name}' is a reserved role name — the built-in roles are defined in code.`);
    }
    const privs = parseJson(payload.privileges);
    if (privs !== null && privs !== undefined) {
      if (typeof privs !== 'object' || Array.isArray(privs)) {
        throw new Error('privileges must be an object of { privilege: boolean }');
      }
      // Strip unknown keys so a crafted payload cannot smuggle a privilege the
      // catalog will only grow to support later.
      const clean = {};
      for (const k of Object.keys(privs)) if (CATALOG[k]) clean[k] = Boolean(privs[k]);
      payload.privileges = clean;
    }
    const brands = parseJson(payload.brands);
    if (brands !== null && brands !== undefined && !Array.isArray(brands)) {
      throw new Error('brands must be an array of brand ids');
    }
    return payload;
  }

  filter('app_roles.items.create', (payload) => validatePayload(payload));
  filter('app_roles.items.update', async (payload, meta) => {
    // A builtin row is display-only. Refuse edits to anything but description.
    for (const key of meta.keys ?? []) {
      const row = await loadRow(key);
      if (row?.builtin) {
        const touched = Object.keys(payload).filter((k) => !['description'].includes(k));
        if (touched.length) throw new Error(`'${row.name}' is a built-in role — it is defined in code, not here.`);
      }
    }
    return validatePayload(payload);
  });

  // Deleting a row tears the materialized artifacts down BEFORE the row goes,
  // while we can still read which role/policy it owned.
  filter('app_roles.items.delete', async (keys) => {
    for (const key of keys) {
      const row = await loadRow(key);
      if (!row) continue;
      if (row.builtin) throw new Error(`'${row.name}' is a built-in role and cannot be deleted.`);
      const schema = await getSchema();
      const opts = { schema, accountability: null, knex: database };
      try {
        if (row.directus_policy) {
          const permissionsService = new PermissionsService(opts);
          const stale = await permissionsService.readByQuery({
            filter: { policy: { _eq: row.directus_policy } }, limit: -1, fields: ['id'],
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
        throw new Error(
          `Cannot delete '${row.name}': ${err?.message ?? err}. Reassign its users to another role first.`,
        );
      }
    }
    return keys;
  });

  action('app_roles.items.create', async (meta) => {
    try { await materialize(meta.key); } catch (err) { warn(`materialize failed: ${err?.message ?? err}`); }
  });
  action('app_roles.items.update', async (meta) => {
    for (const key of meta.keys ?? []) {
      try { await materialize(key); } catch (err) { warn(`materialize failed: ${err?.message ?? err}`); }
    }
  });
};
