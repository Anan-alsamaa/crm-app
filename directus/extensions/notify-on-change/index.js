/**
 * Directus hook: notify-on-change.
 *
 * Produces the notification triggers that originate from Directus PATCHes —
 * which no backend service can observe (spec §13). Specifically:
 *   - conversation/ticket ASSIGNMENT → notify the newly-assigned agent
 *   - ticket STATUS change           → notify the assigned agent
 *   - a HIGH-VALUE coupon request    → notify everyone who can approve one
 *
 * It writes an in-app `notifications` row directly via ItemsService (so the
 * agent's bell shows it), deps-free so it loads in the stock Directus image with
 * no bundling. Self-assignments are skipped (you don't notify yourself).
 *
 * NOTE: this covers the in-app channel. Email + realtime socket push for these
 * events would route through the BullMQ `notifications` queue (workers
 * processor) — a follow-up if those channels are needed for assignment/updates.
 * Mentions are produced by the gateway (note:add), not here.
 */
export default ({ action }, { services, database, getSchema, logger }) => {
  const { ItemsService } = services;

  async function notify(schema, { recipient, actor, type, title, body, link, payload }) {
    if (!recipient || recipient === actor) return; // skip empty + self
    try {
      const notifs = new ItemsService('notifications', { schema, accountability: null });
      await notifs.createOne({
        recipient,
        type,
        title,
        body,
        link: link ?? null,
        payload: payload ?? null,
        channel_inapp_delivered_at: new Date().toISOString(),
      });
    } catch (err) {
      logger?.warn?.(`notify-on-change: failed to create notification: ${err?.message ?? err}`);
    }
  }

  action('conversations.items.update', async (meta, context) => {
    const payload = meta?.payload ?? {};
    if (!payload.assigned_agent) return;
    const schema = await getSchema();
    const actor = context?.accountability?.user ?? null;
    for (const id of meta?.keys ?? []) {
      await notify(schema, {
        recipient: payload.assigned_agent,
        actor,
        type: 'assignment',
        title: 'Conversation assigned to you',
        body: `You were assigned conversation ${id}.`,
        link: `/inbox?conversation=${id}`,
        payload: { conversationId: id },
      });
    }
  });

  action('tickets.items.update', async (meta, context) => {
    const payload = meta?.payload ?? {};
    const hasAssign = Boolean(payload.assigned_agent);
    const hasStatus = Boolean(payload.status);
    if (!hasAssign && !hasStatus) return;

    const schema = await getSchema();
    const actor = context?.accountability?.user ?? null;
    const tickets = new ItemsService('tickets', { schema, accountability: null });

    for (const id of meta?.keys ?? []) {
      if (hasAssign) {
        await notify(schema, {
          recipient: payload.assigned_agent,
          actor,
          type: 'assignment',
          title: 'Ticket assigned to you',
          body: `You were assigned ticket ${id}.`,
          link: `/tickets?ticket=${id}`,
          payload: { ticketId: id },
        });
      }
      if (hasStatus) {
        // The assigned agent may not be in this payload — read it back.
        let agent = payload.assigned_agent ?? null;
        if (!agent) {
          const row = await tickets.readOne(id, { fields: ['assigned_agent'] }).catch(() => null);
          agent = row?.assigned_agent ?? null;
        }
        await notify(schema, {
          recipient: agent,
          actor,
          type: 'ticket_update',
          title: 'Ticket updated',
          body: `Ticket ${id} status changed to ${payload.status}.`,
          link: `/tickets?ticket=${id}`,
          payload: { ticketId: id, status: payload.status },
        });
      }
    }
  });

  /*
   * A single coupon large enough to want an admin's attention on its own.
   *
   * This is NOT the approval queue. Every coupon already needs a supervisor,
   * and that queue is a work list someone opens when they get to it — which is
   * fine for a 15 SAR apology and not fine for a 500 SAR one, because nothing
   * about the queue tells anybody that a large one has arrived. This pushes.
   *
   * It lives in a Directus hook rather than in the agent portal because the row
   * is written straight to Directus by the agent's browser. A check in the
   * dialog is a courtesy that an unpatched tab, a second client, or a direct
   * API call walks straight past; a check here runs on the write itself.
   *
   * Thresholds and the exposure rule are duplicated from
   * @yiji/shared-types (COUPON_ALERT_THRESHOLD_SAR / couponExposure) because
   * extensions load in the stock Directus image with no bundler and cannot
   * import from the workspace. Kept in sync by
   * `packages/shared-types/tests/coupon-request.test.ts`, which asserts these
   * exact numbers so a change on either side fails the build.
   */
  const COUPON_ALERT_THRESHOLD_SAR = 200;
  const PERCENTAGE_CATEGORIES = new Set(['percentage', 'percent', '%']);

  function couponExposure(row) {
    const cap = Number(row?.max_discount ?? 0) || 0;
    const category = String(row?.discount_category ?? '').trim().toLowerCase();
    if (PERCENTAGE_CATEGORIES.has(category)) return cap > 0 ? cap : 0;
    const value = Number(row?.coupon_value ?? 0) || 0;
    return Math.max(value, cap > 0 ? cap : 0);
  }

  /*
   * Roles that can approve a coupon but hold no app_roles privilege list.
   *
   * `Admin` and `Administrator` are BUILT-IN: app-roles-sync skips rows flagged
   * `builtin` and refuses these names outright, so their `privileges` column is
   * permanently NULL. Resolving recipients by privilege alone therefore missed
   * the actual administrators entirely — checked against the live database, the
   * only role carrying `approve_coupons` was Supervisor, which had ZERO users.
   * The alert would have been written, logged as sent, and reached nobody.
   */
  const BUILTIN_APPROVER_ROLES = new Set(['admin', 'administrator']);

  /**
   * Everyone who can act on a coupon approval.
   *
   * Addressed by PRIVILEGE first, not by role name: "the admins" is not a fixed
   * list, and hardcoding one means the alert quietly stops reaching whoever
   * actually does the job the next time roles are reorganised. The built-in
   * names above are a UNION with that, not a replacement — they are the roles
   * the privilege system structurally cannot describe.
   */
  async function couponApprovers() {
    const roleIds = new Set();

    const appRoles = await database('app_roles').select('directus_role', 'privileges');
    for (const r of appRoles) {
      if (!r.directus_role) continue;
      let privileges = r.privileges;
      if (typeof privileges === 'string') {
        try {
          privileges = JSON.parse(privileges);
        } catch {
          privileges = [];
        }
      }
      if (Array.isArray(privileges) && privileges.includes('approve_coupons')) {
        roleIds.add(String(r.directus_role));
      }
    }

    const builtins = await database('directus_roles').select('id', 'name');
    for (const r of builtins) {
      if (BUILTIN_APPROVER_ROLES.has(String(r.name ?? '').trim().toLowerCase())) {
        roleIds.add(String(r.id));
      }
    }

    if (roleIds.size === 0) return [];
    /* Compared as text on both sides. `directus_users.role` is a uuid column and
       `app_roles.directus_role` is varchar, and Postgres will not compare the
       two without a cast — the mismatch throws rather than returning nothing,
       but casting both is what keeps this working across either shape. */
    const users = await database('directus_users')
      .whereRaw('role::text = ANY(?)', [[...roleIds]])
      .andWhere('status', 'active')
      .select('id');
    return users.map((u) => u.id);
  }

  action('coupon_approvals.items.create', async (meta, context) => {
    const payload = meta?.payload ?? {};
    const exposure = couponExposure(payload);
    if (!(exposure > COUPON_ALERT_THRESHOLD_SAR)) return;

    const schema = await getSchema();
    const actor = context?.accountability?.user ?? null;
    const id = meta?.key ?? null;
    const amount = `SAR ${exposure.toFixed(2)}`;
    const code = payload.coupon_code ? ` (${payload.coupon_code})` : '';

    let recipients = [];
    try {
      recipients = await couponApprovers();
    } catch (err) {
      logger?.warn?.(
        `notify-on-change: could not resolve coupon approvers: ${err?.message ?? err}`,
      );
      return;
    }
    if (recipients.length === 0) {
      // Loud, because the alternative is a large coupon that alerted nobody and
      // looked exactly like a small one that alerted nobody.
      logger?.warn?.(
        `notify-on-change: high-value coupon ${amount} raised but NO active user holds approve_coupons`,
      );
      return;
    }

    for (const recipient of recipients) {
      await notify(schema, {
        recipient,
        /* Deliberately NOT skipping the actor. `notify` drops self-notifications
           because nobody needs telling they assigned themselves a ticket — but
           an approver raising a large coupon is precisely the case this alert
           exists to surface, and silence there would be the hole. */
        actor: null,
        type: 'high_value_coupon',
        title: `High-value coupon: ${amount}`,
        body:
          `A coupon worth ${amount}${code} was requested and is waiting for approval. ` +
          `Anything above SAR ${COUPON_ALERT_THRESHOLD_SAR} is flagged for review.`,
        link: '/coupon-approvals',
        payload: {
          couponApprovalId: id,
          exposure,
          couponCode: payload.coupon_code ?? null,
          ticketId: payload.ticket ?? null,
          requestedBy: actor,
        },
      });
    }
    logger?.info?.(
      `notify-on-change: high-value coupon ${amount} alerted ${recipients.length} approver(s)`,
    );
  });
};
