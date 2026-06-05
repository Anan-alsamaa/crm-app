/**
 * Directus hook: notify-on-change.
 *
 * Produces the notification triggers that originate from Directus PATCHes —
 * which no backend service can observe (spec §13). Specifically:
 *   - conversation/ticket ASSIGNMENT → notify the newly-assigned agent
 *   - ticket STATUS change           → notify the assigned agent
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
export default ({ action }, { services, getSchema, logger }) => {
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
};
