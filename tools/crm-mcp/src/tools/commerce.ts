import { CrmHttpError, type CrmClient } from '../client.js';
import { when, whenYiji } from '../format.js';

/**
 * Yiji commerce, through the CRM's own ai-gateway routes on the same host
 * (`GET /commerce/...`). The gateway verifies our Directus token and answers
 * from Yiji — read-only on both sides.
 */

type Row = Record<string, unknown>;

/** The legacy single Yiji vendor, as the portals address it. */
export const YIJI_VENDOR_ID = '1';

function explain(err: unknown): string {
  if (err instanceof CrmHttpError) {
    if (err.status === 504)
      return 'Yiji did not answer (504 commerce_unavailable) — unknown, NOT "no data".';
    if (err.status === 404) return `Not found (${err.message}).`;
    return err.message;
  }
  throw err;
}

const money = (v: unknown) => (v === null || v === undefined ? '-' : `${v}`);

export async function getOrder(c: CrmClient, orderId: string): Promise<string> {
  let body: { data?: Row | null };
  try {
    body = await c.get('/commerce/order', { orderId: orderId.trim(), vendorId: YIJI_VENDOR_ID });
  } catch (err) {
    return `Order ${orderId}: ${explain(err)}`;
  }
  const o = body?.data;
  if (!o) return `Order ${orderId}: Yiji returned no order.`;
  const items = Array.isArray(o.items) ? (o.items as Row[]) : [];
  const out = [
    `Order ${o.orderId}  [${o.status}]  ${o.deliveryType ?? '-'}`,
    `Placed ${whenYiji(o.placedAt)} · brand ${o.brandName ?? '-'} · branch ${o.restaurantName ?? '-'} (restaurantId ${o.restaurantId ?? '-'})`,
    `Customer phone ${o.customerPhone ?? '-'} · address ${o.deliveryAddress ?? '-'}`,
    `Total ${money(o.total)} ${o.currency ?? ''} · payment ${o.paymentMode ?? '-'} / ${o.paymentStatus ?? '-'} · discount ${money(o.totalDiscount)} · coupons ${money(o.totalCouponAmount)} · points ${money(o.totalPointAmount)}`,
    '',
    `Items (${items.length}):`,
  ];
  for (const it of items) {
    const mods =
      Array.isArray(it.modifiers) && it.modifiers.length
        ? ` — ${(it.modifiers as string[]).join(', ')}`
        : '';
    out.push(
      `  ${it.qty} x ${it.name} @ ${money(it.price)}  [sku ${it.sku ?? '-'}${it.category ? `, ${it.category}` : ''}]${mods}`,
    );
  }
  if (!items.length) out.push('  (none listed)');
  return out.join('\n');
}

export interface LateOrdersArgs {
  from?: string;
  to?: string;
  live?: boolean;
  limit?: number;
}

export async function lateOrders(c: CrmClient, a: LateOrdersArgs): Promise<string> {
  const history = Boolean(a.from || a.to);
  let body: { data?: { rows?: Row[]; thresholdMinutes?: number; builtAt?: string } };
  try {
    body = await c.get('/commerce/late-orders', {
      from: a.from,
      to: a.to,
      live: history && a.live ? '1' : undefined,
    });
  } catch (err) {
    return `Late orders: ${explain(err)}`;
  }
  const rows = [...(body?.data?.rows ?? [])].sort(
    (x, y) => Number(y.minutesElapsed ?? 0) - Number(x.minutesElapsed ?? 0),
  );
  const limit = Math.min(a.limit ?? 50, 300);
  const shown = rows.slice(0, limit);
  const live = rows.filter((r) => r.live !== false).length;
  const out = [
    history
      ? `Late-orders REGISTER ${a.from ?? a.to}..${a.to ?? a.from} (includes finished orders)`
      : `Late-orders LIVE queue (today, still running)`,
    `Threshold ${body?.data?.thresholdMinutes ?? '?'} min · ${rows.length} orders (${live} live) · built ${when(body?.data?.builtAt)}`,
    `Most late first${rows.length > limit ? `; showing ${limit} of ${rows.length}` : ''}. minutes = placed→now (live) or placed→final status (finished).`,
    '',
  ];
  for (const r of shown) {
    out.push(
      `${r.orderId} [${r.status}${r.live === false ? ', finished' : ', LIVE'}] ${r.minutesElapsed} min · placed ${whenYiji(r.placedAt)} · ${r.brandName ?? '-'} / ${r.restaurantName ?? '-'} · ${r.customerName ?? '-'} ${r.customerPhone ?? '-'} · total ${money(r.total)}`,
    );
  }
  if (!rows.length) out.push('(no late orders — Yiji answered, and nothing is past the threshold)');
  return out.join('\n');
}
