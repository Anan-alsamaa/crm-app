import type { CrmClient } from '../client.js';
import { clip, person, phoneNeedle, rangeFilter, redact, rel, when } from '../format.js';
import { couponLines, COUPON_FIELDS } from './coupons.js';

type Row = Record<string, unknown>;

const USER = (p: string) => [`${p}.first_name`, `${p}.last_name`];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TicketSearch {
  id?: string;
  orderId?: string;
  phone?: string;
  text?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function searchTickets(c: CrmClient, a: TicketSearch): Promise<string> {
  const and: object[] = [];
  if (a.id) {
    if (!UUID.test(a.id))
      return `"${a.id}" is not a ticket id (a UUID). Use orderId/phone/text to search.`;
    and.push({ id: { _eq: a.id } });
  }
  if (a.orderId) and.push({ order_id: { _eq: a.orderId.trim() } });
  if (a.phone) {
    const p = phoneNeedle(a.phone);
    and.push({
      _or: [{ customer_phone: { _contains: p } }, { contact: { phone: { _contains: p } } }],
    });
  }
  if (a.text)
    and.push({
      _or: [{ subject: { _icontains: a.text } }, { description: { _icontains: a.text } }],
    });
  if (a.status) and.push({ status: { _eq: a.status } });
  const range = rangeFilter('date_created', a.from, a.to);
  if (range) and.push(range);
  const limit = Math.min(a.limit ?? 20, 100);

  const rows = await c.items<Row>('tickets', {
    fields: [
      'id',
      'subject',
      'status',
      'priority',
      'order_id',
      'customer_phone',
      'complaint_type',
      'compensation',
      'date_created',
      'resolved_at',
      'contact.name',
      'contact.phone',
      ...USER('assigned_agent'),
      'store.name',
    ],
    filter: and.length ? { _and: and } : undefined,
    sort: ['-date_created'],
    limit,
  });
  const lines = [
    `Tickets: ${rows.length}${rows.length === limit ? ` (limit ${limit} reached — narrow the search)` : ''}`,
    'Newest first. Date range applies to date_created (Riyadh days). Text matches subject or description.',
    '',
  ];
  for (const t of rows) {
    lines.push(
      `${t.id}  [${t.status}]  ${clip(t.subject, 120)}`,
      `   order ${t.order_id ?? '-'} · ${rel(t.contact, 'name')} ${t.customer_phone ?? rel(t.contact, 'phone')} · ${t.complaint_type ?? '-'} · comp ${t.compensation ?? '-'} · store ${rel(t.store, 'name')}`,
      `   agent ${person(t.assigned_agent)} · created ${when(t.date_created)}${t.resolved_at ? ` · resolved ${when(t.resolved_at)}` : ''}`,
    );
  }
  if (!rows.length) lines.push('(no matching tickets)');
  return lines.join('\n');
}

export async function getTicket(c: CrmClient, id: string): Promise<string> {
  if (!UUID.test(id)) return `"${id}" is not a ticket id (a UUID). Use crm_search_tickets first.`;
  const t = await c.item<Row>('tickets', id, [
    'id',
    'subject',
    'description',
    'status',
    'priority',
    'date_created',
    'date_updated',
    'first_response_due_at',
    'first_responded_at',
    'resolution_due_at',
    'resolved_at',
    'closed_at',
    'order_id',
    'customer_phone',
    'complaint_date',
    'complaint_type',
    'service_type',
    'complaint_source',
    'communication_method',
    'response_desc',
    'compensation',
    'coupon_code',
    'coupon_value',
    'coupon_percent',
    'conversation',
    'contact.name',
    'contact.phone',
    'vendor.name',
    'store.name',
    ...USER('assigned_agent'),
    ...USER('user_created'),
    'assigned_team.name',
  ]);
  if (!t) return `Ticket ${id} not found.`;

  const [events, coupons] = await Promise.all([
    c.items<Row>('ticket_events', {
      fields: ['date_created', 'event_type', 'payload', ...USER('actor')],
      filter: { ticket: { _eq: id } },
      sort: ['date_created'],
      limit: 200,
    }),
    c.items<Row>('coupon_approvals', {
      fields: COUPON_FIELDS,
      filter: { ticket: { _eq: id } },
      sort: ['date_created'],
      limit: 20,
    }),
  ]);

  const out = [
    `Ticket ${t.id}  [${t.status}]  priority ${t.priority ?? '-'}`,
    `Subject: ${clip(t.subject, 300)}`,
    `Description: ${clip(t.description, 1200) || '-'}`,
    `Customer: ${rel(t.contact, 'name')} · ${t.customer_phone ?? rel(t.contact, 'phone')} · vendor ${rel(t.vendor, 'name')} · store ${rel(t.store, 'name')}`,
    `Order: ${t.order_id ?? '-'} · conversation ${t.conversation ?? '-'}`,
    `Complaint: type ${t.complaint_type ?? '-'} · service ${t.service_type ?? '-'} · source ${t.complaint_source ?? '-'} · via ${t.communication_method ?? '-'} · date ${when(t.complaint_date)}`,
    `Compensation: ${t.compensation ?? '-'} · coupon ${t.coupon_code ?? '-'} value ${t.coupon_value ?? '-'} percent ${t.coupon_percent ?? '-'}`,
    `Response: ${clip(t.response_desc, 600) || '-'}`,
    `Agent ${person(t.assigned_agent)} · team ${rel(t.assigned_team, 'name')} · created by ${person(t.user_created)}`,
    `Created ${when(t.date_created)} · updated ${when(t.date_updated)} · resolved ${when(t.resolved_at)} · closed ${when(t.closed_at)}`,
    `SLA: first response due ${when(t.first_response_due_at)} / done ${when(t.first_responded_at)} · resolution due ${when(t.resolution_due_at)}`,
    '',
    `Timeline (ticket_events, ${events.length}):`,
    ...(events.length
      ? events.map(
          (e) =>
            `  ${when(e.date_created)} ${e.event_type} by ${person(e.actor)}${e.payload ? ` ${clip(JSON.stringify(redact(e.payload)), 300)}` : ''}`,
        )
      : ['  (none)']),
    '',
    `Coupon requests on this ticket (${coupons.length}):`,
    ...(coupons.length
      ? coupons.flatMap((r) => couponLines(r).map((l) => `  ${l}`))
      : ['  (none)']),
  ];
  return out.join('\n');
}
