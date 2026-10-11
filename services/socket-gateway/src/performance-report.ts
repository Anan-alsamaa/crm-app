import { z } from 'zod';

/**
 * AGENT PERFORMANCE, READ BY THE SERVER (owner, 2026-10-11).
 *
 * "If I log in with Amjad and select Ali in the filter, there is no data."
 * The page read chats, messages and tickets with the AGENT's own token, and a
 * WeCare Agent may read only their own live chats - so another agent's
 * performance came back empty. The owner wants everyone on that page to see
 * everything ON THAT PAGE, without widening what an agent may open in the
 * inbox (live chats stay private, 2026-09-14).
 *
 * So the page's reads run here, with the gateway's service token, as a FIXED
 * set of named datasets. The client chooses only the dataset and the filters
 * (dates, agent, vendor) or a list of ids it already received; every field
 * list is decided here. No message text is ever returned - only who sent what
 * when, which is all the timings need.
 */

const idSchema = z.string().trim().min(1).max(64);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/)
  .max(40);

export const PerformanceQuery = z.object({
  dataset: z.enum([
    'conversations',
    'linkedTickets',
    'messages',
    'routingEvents',
    'csat',
    'tickets',
    'ticketCoupons',
    'coupons',
    'couponExtra',
  ]),
  filters: z
    .object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      agentId: z.string().max(64).optional(),
      vendor: z.string().max(64).optional(),
    })
    .default({}),
  ids: z.array(idSchema).max(5000).optional(),
  field: z.enum(['delivery_excluded', 'yiji_coupon_id', 'awaiting_signup_at', 'ticket']).optional(),
});
export type PerformanceQuery = z.infer<typeof PerformanceQuery>;

/** Reads one collection with the service token. Returns the rows. */
export type ServiceRead = (
  collection: string,
  query: Record<string, unknown>,
) => Promise<unknown[]>;

const endOfDay = (d: string) => `${d.slice(0, 10)}T23:59:59.999Z`;
/** Ids per request: a long `_in` list is an over-long URL. */
const CHUNK = 100;

async function chunked(
  read: ServiceRead,
  ids: string[],
  q: (chunk: string[]) => [string, Record<string, unknown>],
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const [col, query] = q(ids.slice(i, i + CHUNK));
    out.push(...(await read(col, query)));
  }
  return out;
}

function dateWindow(f: PerformanceQuery['filters'], field = 'date_created') {
  const and: Array<Record<string, unknown>> = [];
  if (f.from) and.push({ [field]: { _gte: f.from } });
  if (f.to) and.push({ [field]: { _lte: endOfDay(f.to) } });
  return and;
}

/** Runs one named dataset. Throws on a bad request (the route answers 400). */
export async function readPerformanceDataset(
  read: ServiceRead,
  q: PerformanceQuery,
): Promise<unknown[]> {
  const f = q.filters;
  const ids = [...new Set(q.ids ?? [])];
  switch (q.dataset) {
    case 'conversations': {
      const and = dateWindow(f);
      if (f.agentId) and.push({ assigned_agent: { _eq: f.agentId } });
      if (f.vendor) and.push({ vendor: { _eq: f.vendor } });
      return read('conversations', {
        limit: -1,
        fields: [
          'id',
          'status',
          'assigned_agent',
          'solved_at',
          'date_created',
          'last_order_id',
          'initiated_by',
          'contact.id',
          'contact.name',
          'contact.phone',
        ],
        ...(and.length ? { filter: { _and: and } } : {}),
      });
    }
    case 'linkedTickets':
      return chunked(read, ids, (c) => [
        'tickets',
        {
          limit: -1,
          filter: { conversation: { _in: c } },
          fields: ['id', 'conversation', 'subject', 'complaint_type'],
          sort: ['-date_created'],
        },
      ]);
    case 'messages':
      // Metadata only: who wrote, when. Never `content`.
      return chunked(read, ids, (c) => [
        'messages',
        {
          limit: -1,
          filter: { conversation: { _in: c }, is_internal_note: { _eq: false } },
          fields: ['conversation', 'sender_type', 'date_created', 'sender_user'],
          sort: ['date_created'],
        },
      ]);
    case 'routingEvents':
      return chunked(read, ids, (c) => [
        'routing_events',
        {
          limit: -1,
          filter: { conversation: { _in: c } },
          fields: ['conversation', 'agent', 'outcome', 'stage'],
        },
      ]);
    case 'csat': {
      // By conversation when ids are given (the chat table's rating column);
      // else by submission window, as the page always read it.
      if (ids.length)
        return chunked(read, ids, (c) => [
          'csat_responses',
          { limit: -1, filter: { conversation: { _in: c } }, fields: ['conversation', 'score'] },
        ]);
      const and = dateWindow(f, 'submitted_at');
      return read('csat_responses', {
        limit: -1,
        fields: ['conversation', 'score'],
        ...(and.length ? { filter: { _and: and } } : {}),
      });
    }
    case 'tickets': {
      const and = dateWindow(f);
      if (f.agentId)
        and.push({
          _or: [{ assigned_agent: { _eq: f.agentId } }, { user_created: { _eq: f.agentId } }],
        });
      if (f.vendor) and.push({ vendor: { _eq: f.vendor } });
      return read('tickets', {
        limit: -1,
        fields: [
          'id',
          'subject',
          'complaint_type',
          'order_id',
          'status',
          'assigned_agent',
          'user_created',
          'date_created',
          'resolved_at',
          'closed_at',
          'customer_phone',
          'contact.id',
          'contact.name',
          'contact.phone',
        ],
        sort: ['-date_created'],
        ...(and.length ? { filter: { _and: and } } : {}),
      });
    }
    case 'ticketCoupons':
      return chunked(read, ids, (c) => [
        'coupon_approvals',
        {
          limit: -1,
          filter: { ticket: { _in: c } },
          fields: ['ticket', 'coupon_code', 'status'],
          sort: ['-date_created'],
        },
      ]);
    case 'coupons':
    case 'couponExtra': {
      const and = dateWindow(f);
      if (f.agentId) and.push({ requested_by: { _eq: f.agentId } });
      if (f.vendor) and.push({ vendor: { _eq: f.vendor } });
      const filter = and.length ? { filter: { _and: and } } : {};
      if (q.dataset === 'couponExtra') {
        if (!q.field) throw new Error('field is required');
        return read('coupon_approvals', { limit: -1, fields: ['id', q.field], ...filter });
      }
      return read('coupon_approvals', {
        limit: -1,
        sort: ['-date_created'],
        fields: [
          'id',
          'coupon_code',
          'coupon_value',
          'coupon_percent',
          'discount_category',
          'status',
          'date_created',
          'order_id',
          'customer_phone',
          'ticket.id',
          'ticket.subject',
          'ticket.order_id',
          'ticket.complaint_type',
          'contact.id',
          'contact.name',
          'contact.phone',
          'requested_by.id',
          'requested_by.first_name',
          'requested_by.email',
        ],
        ...filter,
      });
    }
  }
}
