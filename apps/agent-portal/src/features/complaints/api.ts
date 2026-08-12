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

interface TicketRow {
  id: string;
  status: string;
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
  'store_snapshot',
  { contact: ['name', 'phone'] },
] as const;

/**
 * `agentName` is passed in rather than joined: every row here belongs to the
 * signed-in agent by construction, so reading it back per ticket would be a
 * relational query for a value we already hold.
 */
export function toComplaintRow(t: TicketRow, agentName: string): ComplaintReportRow {
  const { date, time } = splitLocalDateTime(t.date_created);
  const snap = t.order_snapshot ?? null;
  return {
    id: t.id,
    date,
    time,
    // Store-derived columns are filled by joinComplaintStores on the page,
    // which owns the store index. Blank here rather than guessed, so an
    // unjoined row is visibly unjoined.
    chain: '',
    area: '',
    brand: snap?.brandName?.trim() ?? '',
    city: '',
    restaurantName: snap?.restaurantName?.trim() ?? '',
    storeMapped: false,
    serviceType: t.service_type ?? '',
    complaintType: t.complaint_type ?? '',
    customerName: t.contact?.name ?? '',
    customerMobile: t.contact?.phone ?? '',
    complaintDescription: t.description ?? '',
    responseDesc: t.response_desc ?? '',
    complaintSource: t.complaint_source ?? '',
    orderAmount: toNumber(snap?.total),
    orderNumber: snap?.orderId ? String(snap.orderId) : '',
    communicationMethod: t.communication_method ?? '',
    couponCode: t.coupon_code ?? '',
    couponValue: toNumber(t.coupon_value),
    couponPercent: toNumber(t.coupon_percent),
    complaintStatus: t.status,
    agent: agentName,
    compensation: t.compensation ?? '',
    storeSnapshot: t.store_snapshot ?? null,
  };
}

export function useMyComplaints(days: number, agentName: string) {
  return useQuery({
    queryKey: ['my-complaints', days, agentName],
    staleTime: 60_000,
    queryFn: async (): Promise<ComplaintReportRow[]> => {
      const since = new Date(Date.now() - days * DAY_MS).toISOString();
      const rows = (await directus.request(
        readItems('tickets', {
          limit: -1,
          filter: { _and: [MINE, { date_created: { _gte: since } }] },
          sort: ['-date_created'],
          fields: FIELDS as never,
        }),
      )) as TicketRow[];
      return rows.map((r) => toComplaintRow(r, agentName));
    },
  });
}
