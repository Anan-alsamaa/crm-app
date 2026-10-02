import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import type { StoreSnapshot } from '@yiji/shared-types';
import { splitLocalDateTime, type ComplaintReportRow } from '@yiji/reports';
import { directus } from '../../lib/directus.js';

/**
 * The agent's own complaints, in the operations team's report shape.
 *
 * Same 24 columns as the manager's report — the format lives in `@yiji/reports`
 * so the two can never drift — but a narrower set of rows: an agent sees the
 * complaints assigned to them, the manager sees all of them.
 */

const DAY_MS = 86_400_000;

/**
 * The scope is enforced twice, on purpose.
 *
 * Directus already restricts the Agent role's ticket reads to
 * `assigned_agent = $CURRENT_USER` (see directus/bootstrap/src/roles.ts), so
 * this filter is redundant *today*. It is here because the page promises "my
 * complaints", and a page that silently widens when someone loosens a role
 * permission is the worst version of this feature: a table that still says
 * "mine" while showing the whole operation, with nothing on screen to say so.
 * Stating the scope in the query keeps the promise true regardless of the role
 * config.
 */
const MINE = { assigned_agent: { _eq: '$CURRENT_USER' } };

/**
 * A complaint row plus the few ticket fields the Tickets page works with but
 * the operations report has no column for. Kept as an extension rather than
 * pushed into the shared row, so the exported sheet stays exactly the ops
 * team's 24 columns.
 */
export interface AgentComplaintRow extends ComplaintReportRow {
  subject: string;
  firstRespondedAt: string | null;
  firstResponseDueAt: string | null;
}

interface TicketRow {
  id: string;
  status: string;
  subject: string | null;
  complaint_date: string | null;
  first_responded_at: string | null;
  first_response_due_at: string | null;
  date_created: string | null;
  description: string | null;
  complaint_type: string | null;
  service_type: string | null;
  complaint_source: string | null;
  communication_method: string | null;
  response_desc: string | null;
  compensation: string | null;
  coupon_code: string | null;
  coupon_value: number | string | null;
  coupon_percent: number | string | null;
  order_snapshot: {
    orderId?: string | number | null;
    total?: number | string | null;
    brandName?: string | null;
    restaurantName?: string | null;
  } | null;
  /** The searchable copy of the order number — see the field list below. */
  order_id: string | null;
  store_snapshot: StoreSnapshot | null;
  contact: { name: string | null; phone: string | null } | null;
}

/** Numeric cell that tolerates the sheet's `-`, `""` and `"102.85 SR"`. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d+(\.\d+)?/.exec(v.replace(/,/g, ''));
  return m ? Number(m[0]) : null;
}

const FIELDS = [
  'id',
  'status',
  'subject',
  'complaint_date',
  'first_responded_at',
  'first_response_due_at',
  'date_created',
  'description',
  'complaint_type',
  'service_type',
  'complaint_source',
  'communication_method',
  'response_desc',
  'compensation',
  'coupon_code',
  'coupon_value',
  'coupon_percent',
  'order_snapshot',
  /*
   * THE SEARCHABLE ORDER NUMBER, and the reason it is a COLUMN.
   *
   * `order_snapshot` is json, which Directus cannot filter — which is exactly
   * why `tickets.order_id` exists beside it. It was not requested here, so
   * `orderNumber` below was built from the snapshot alone and a ticket with no
   * snapshot was unfindable by its order number (ops, 2026-10-03).
   *
   * A ticket raised from the LATE-ORDERS queue is precisely that case: it is
   * created with `order_id` set and no snapshot at all, so the number was in
   * the database and invisible to the search above it.
   */
  'order_id',
  'store_snapshot',
  { contact: ['name', 'phone'] },
] as const;

/**
 * `agentName` is passed in rather than joined: every row here belongs to the
 * signed-in agent by construction, so reading it back per ticket would be a
 * relational query for a value we already hold.
 */
export function toComplaintRow(t: TicketRow, agentName: string): AgentComplaintRow {
  // When it HAPPENED, not when it was typed in. Older tickets have no
  // complaint_date, so they keep dating from creation rather than going blank.
  const when = splitLocalDateTime(t.complaint_date ?? t.date_created);
  const snap = t.order_snapshot ?? null;
  return {
    id: t.id,
    ...when,
    // Store-derived columns are filled by joinComplaintStores on the page,
    // which owns the store index. Blank here rather than guessed, so an
    // unjoined row is visibly unjoined.
    chain: '',
    area: '',
    brand: snap?.brandName?.trim() ?? '',
    city: '',
    restaurantName: snap?.restaurantName?.trim() ?? '',
    // Filled by the store join; blank until then.
    storeCode: '',
    yijiRestaurantId: '',
    storeMapped: false,
    serviceType: t.service_type ?? '',
    complaintType: t.complaint_type ?? '',
    customerName: t.contact?.name ?? '',
    customerMobile: t.contact?.phone ?? '',
    complaintDescription: t.description ?? '',
    responseDesc: t.response_desc ?? '',
    complaintSource: t.complaint_source ?? '',
    orderAmount: toNumber(snap?.total),
    /* The COLUMN first, the snapshot second. The column is the one that is
       always written; the snapshot is absent on a late-order ticket. Either
       alone leaves a real order number unsearchable. */
    orderNumber: String(t.order_id ?? snap?.orderId ?? ''),
    communicationMethod: t.communication_method ?? '',
    couponCode: t.coupon_code ?? '',
    couponValue: toNumber(t.coupon_value),
    couponPercent: toNumber(t.coupon_percent),
    complaintStatus: t.status,
    agent: agentName,
    compensation: t.compensation ?? '',
    // The agent queue never shows the audit stamp; the admin report does.
    lastModifiedBy: '',
    lastModifiedAt: '',
    storeSnapshot: t.store_snapshot ?? null,
    subject: t.subject ?? '',
    firstRespondedAt: t.first_responded_at ?? null,
    firstResponseDueAt: t.first_response_due_at ?? null,
  };
}

/**
 * `days` of null means every complaint the agent has, with no date window —
 * what the Tickets page needs, since a window there would quietly hide older
 * tickets an agent still has to work.
 */
/**
 * WHOSE TICKETS TO SHOW.
 *
 * `'me'` is the page's default and what it has always done. `'all'` and a
 * specific agent id were added because the scope was invisible and absolute:
 * an Administrator opening Tickets saw nothing but their own, and a ticket
 * raised from the late-orders queue belongs to the agent who decided it — so
 * the owner, looking for Shatha's late-preparation ticket, correctly saw an
 * empty page and reasonably read it as missing data (owner, 2026-09-30).
 */
export type ComplaintScope = 'me' | 'all' | (string & {});

export function useMyComplaints(
  days: number | null,
  agentName: string,
  scope: ComplaintScope = 'me',
) {
  return useQuery({
    queryKey: ['my-complaints', days, agentName, scope],
    staleTime: 60_000,
    queryFn: async (): Promise<AgentComplaintRow[]> => {
      const since = days == null ? null : new Date(Date.now() - days * DAY_MS).toISOString();
      /*
       * `'all'` sends NO agent clause and lets Directus decide.
       *
       * That is the honest scope rather than a wider promise: a WeCare Agent's
       * role still restricts their reads to their own tickets, so picking "All"
       * shows them exactly what they were always allowed to see. A supervisor,
       * admin or the owner has an unscoped read rule and sees the operation.
       * The page cannot grant access it does not have, and does not pretend to.
       */
      const who =
        scope === 'all' ? null : scope === 'me' ? MINE : { assigned_agent: { _eq: scope } };
      const clauses = [
        ...(who ? [who] : []),
        ...(since ? [{ date_created: { _gte: since } }] : []),
      ];
      const filter =
        clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : { _and: clauses };
      const rows = (await directus.request(
        readItems('tickets', {
          limit: -1,
          ...(filter ? { filter } : {}),
          sort: ['-date_created'],
          fields: FIELDS as never,
        }),
      )) as TicketRow[];
      return rows.map((r) => toComplaintRow(r, agentName));
    },
  });
}
