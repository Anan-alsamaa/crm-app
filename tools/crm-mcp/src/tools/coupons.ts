import type { CrmClient } from '../client.js';
import { clip, person, phoneNeedle, rangeFilter, rel, when } from '../format.js';

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const COUPON_FIELDS = [
  'id',
  'date_created',
  'status',
  'coupon_code',
  'title',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'discount_category',
  'coupon_type',
  'delivery_type',
  'issuing_side',
  'usage_limit',
  'valid_from',
  'valid_to',
  'compensation',
  'reason',
  'order_id',
  'customer_phone',
  'item_name',
  'item_sku',
  'brand_id',
  'restaurant_id',
  'no_other_discounts',
  'edited_by_admin',
  'decided_at',
  'decision_note',
  'yiji_coupon_user_id',
  'yiji_coupon_id',
  'yiji_pushed_at',
  'yiji_push_error',
  'delivery_excluded',
  'delivery_excluded_reason',
  'awaiting_signup_at',
  'signup_checked_at',
  'ticket',
  'contact.name',
  'contact.phone',
  'requested_by.first_name',
  'requested_by.last_name',
  'decided_by.first_name',
  'decided_by.last_name',
];

export function couponLines(r: Row): string[] {
  const amount =
    r.coupon_percent !== null && r.coupon_percent !== undefined
      ? `${r.coupon_percent}%${r.max_discount ? ` (max ${r.max_discount} SAR)` : ''}`
      : `${r.coupon_value ?? '-'} SAR`;
  const yiji = r.yiji_pushed_at
    ? `pushed ${when(r.yiji_pushed_at)} · couponUserId ${r.yiji_coupon_user_id ?? '-'} · couponId ${r.yiji_coupon_id ?? '-'}`
    : r.delivery_excluded
      ? `WITHHELD from Yiji (${r.delivery_excluded_reason ?? 'no reason'})`
      : r.awaiting_signup_at
        ? `awaiting customer signup since ${when(r.awaiting_signup_at)} (last check ${when(r.signup_checked_at)})`
        : 'not pushed';
  return [
    `${r.id}  [${r.status}]  code ${r.coupon_code ?? '-'} · ${amount} · ${r.discount_category ?? '-'} · type ${r.coupon_type ?? '-'}${r.title ? ` · "${clip(r.title, 60)}"` : ''}`,
    `   customer ${rel(r.contact, 'name')} ${r.customer_phone ?? rel(r.contact, 'phone')} · order ${r.order_id ?? '-'} · ticket ${r.ticket ?? '-'}`,
    `   terms: valid ${r.valid_from ?? '-'}..${r.valid_to ?? '-'} · usage ${r.usage_limit ?? '-'} · delivery ${r.delivery_type ?? '-'} · issuer ${r.issuing_side ?? '-'}${r.item_name ? ` · item ${r.item_name} (${r.item_sku ?? '-'})` : ''}${r.no_other_discounts ? ' · no other discounts' : ''}`,
    `   compensation ${r.compensation ?? '-'} · reason: ${clip(r.reason, 200) || '-'}`,
    `   requested by ${person(r.requested_by)} ${when(r.date_created)} · decided by ${person(r.decided_by)} ${when(r.decided_at)}${r.edited_by_admin ? ' (edited by admin)' : ''}${r.decision_note ? ` · note: ${clip(r.decision_note, 160)}` : ''}`,
    `   yiji: ${yiji}${r.yiji_push_error ? ` · PUSH ERROR: ${clip(r.yiji_push_error, 300)}` : ''}`,
  ];
}

export interface CouponSearch {
  id?: string;
  code?: string;
  phone?: string;
  orderId?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function searchCoupons(c: CrmClient, a: CouponSearch): Promise<string> {
  const and: object[] = [];
  if (a.id) {
    if (!UUID.test(a.id)) return `"${a.id}" is not a coupon approval id (a UUID).`;
    and.push({ id: { _eq: a.id } });
  }
  if (a.code) and.push({ coupon_code: { _icontains: a.code.trim() } });
  if (a.phone) {
    const p = phoneNeedle(a.phone);
    and.push({
      _or: [{ customer_phone: { _contains: p } }, { contact: { phone: { _contains: p } } }],
    });
  }
  if (a.orderId) and.push({ order_id: { _eq: a.orderId.trim() } });
  if (a.status) and.push({ status: { _eq: a.status } });
  const range = rangeFilter('date_created', a.from, a.to);
  if (range) and.push(range);
  const limit = Math.min(a.limit ?? 20, 100);

  const rows = await c.items<Row>('coupon_approvals', {
    fields: COUPON_FIELDS,
    filter: and.length ? { _and: and } : undefined,
    sort: ['-date_created'],
    limit,
  });
  const lines = [
    `Coupon approvals: ${rows.length}${rows.length === limit ? ` (limit ${limit} reached — narrow the search)` : ''}`,
    'Newest first. Date range applies to date_created (requested), Riyadh days. Statuses: pending, edited, approved, rejected, assigned.',
    '',
  ];
  for (const r of rows) lines.push(...couponLines(r));
  if (!rows.length) lines.push('(no matching coupon approvals)');
  return lines.join('\n');
}
