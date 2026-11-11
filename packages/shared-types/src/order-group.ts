import { normalizePhone } from './phone.js';

/**
 * GROUP ORDERS (food court): ONE COUPON, ON THE MASTER (owner, 2026-11-11).
 *
 * A Yiji "group order" is one order to several restaurants. Yiji stores it as a
 * MASTER order plus one SUBORDER per restaurant:
 *  - master:   `restaurantGroupId` set, `restaurantGroupOrderId` null;
 *  - suborder: `restaurantGroupOrderId` = the master's id.
 * (`isMainSubOrder` and `subFoodCourtOrders` are false/empty on every real
 * order, so neither tells anything.) The suborders come from the order API's
 * `GET /api/Order/GetFoodCourtSubOrders/{masterId}`.
 *
 * Measured on prod, 12 Oct - 11 Nov 2026 (26,608 orders): 365 masters, each
 * with 2-3 suborders. When a coupon is USED on one, Yiji writes the full amount
 * on the master and an EQUAL share on every suborder, whatever each
 * restaurant's food cost (32 -> 16 + 16, 5 -> 1.6667 x 3). Compensation is
 * already linked to the master (13 of 14 grants on group orders).
 *
 * The CRM's rule, matching Yiji's:
 *  - a group order gets ONE coupon, linked to the MASTER - a suborder number is
 *    switched to its master;
 *  - the suborders are saved with the coupon as its BREAKDOWN, equal shares;
 *  - shares are NOT rounded (owner: "a small rounding can give a big
 *    discrepancy") - each is exactly amount / n, as Yiji stores it. Screens
 *    show two decimals; totals add the stored values.
 *  - the breakdown is never derived from the master's own totals: its food
 *    price is often higher than its suborders added up (85 vs 24 + 46).
 */

/** One restaurant's part of a group order. */
export interface OrderGroupSuborder {
  orderId: string;
  restaurantId: number | null;
  brandId: number | null;
  restaurantName: string | null;
  brandName: string | null;
}

/** A group order as read from Yiji. */
export interface OrderGroup {
  /** The master order - the one a coupon is linked to. */
  masterId: string;
  /** The order number the lookup started from (the master or a suborder). */
  enteredId: string;
  /** Yiji's food-court (restaurant group) id. */
  restaurantGroupId: number | null;
  /** The master order's customer, `05XXXXXXXX` when known. */
  customerPhone: string | null;
  suborders: OrderGroupSuborder[];
}

/** One line of a coupon's saved breakdown (`coupon_approvals.order_breakdown`). */
export interface OrderBreakdownLine {
  order_id: string;
  restaurant_id: number | null;
  brand_id: number | null;
  restaurant_name: string | null;
  brand_name: string | null;
  /** amount / number of suborders - exact, never rounded. */
  share: number;
}

/** The saved breakdown: which amount was split, and how. */
export interface OrderBreakdown {
  /** The master order the coupon is linked to. */
  master_order_id: string;
  /** What was split: the coupon's value (Amount) or its maximum discount (Percentage). */
  basis: 'amount' | 'max_discount';
  /** The amount that was split (SAR). */
  amount: number;
  lines: OrderBreakdownLine[];
}

/** The raw order fields this module reads (Yiji `GetOrderAsync` / `GetOrder`). */
export interface RawGroupOrderFields {
  id?: number | string | null;
  restaurantGroupId?: number | null;
  restaurantGroupOrderId?: number | string | null;
  restaurantId?: number | string | null;
  brandId?: number | string | null;
  restaurantName?: string | null;
  brandName?: string | null;
  customerPhoneNumber?: string | null;
}

const idOf = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return /^\d+$/.test(s) && Number(s) > 0 ? s : null;
};
const numOf = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Where one order sits: the master of a group, a suborder of one, or neither.
 * `masterId` is the order a coupon must be linked to.
 */
export function groupRoleOf(
  raw: RawGroupOrderFields | null | undefined,
): { role: 'master' | 'sub'; masterId: string } | null {
  if (!raw) return null;
  const own = idOf(raw.id);
  const parent = idOf(raw.restaurantGroupOrderId);
  if (parent) return { role: 'sub', masterId: parent };
  if (own && raw.restaurantGroupId !== null && raw.restaurantGroupId !== undefined) {
    return { role: 'master', masterId: own };
  }
  return null;
}

/** A suborder row from `GetFoodCourtSubOrders`, mapped. Null when it has no id. */
export function toGroupSuborder(raw: RawGroupOrderFields): OrderGroupSuborder | null {
  const orderId = idOf(raw.id);
  if (!orderId) return null;
  return {
    orderId,
    restaurantId: numOf(raw.restaurantId),
    brandId: numOf(raw.brandId),
    restaurantName: textOf(raw.restaurantName),
    brandName: textOf(raw.brandName),
  };
}

/**
 * The amount a coupon's breakdown splits: an Amount coupon's value, or a
 * Percentage coupon's maximum discount (its real value is only known once it
 * is used). Null when there is nothing positive to split.
 */
export function breakdownBasis(row: {
  discount_category?: string | null;
  coupon_value?: number | string | null;
  max_discount?: number | string | null;
}): { basis: OrderBreakdown['basis']; amount: number } | null {
  const pct = /^percent/i.test(String(row.discount_category ?? ''));
  const amount = numOf(pct ? row.max_discount : row.coupon_value);
  if (amount === null || !(amount > 0)) return null;
  return { basis: pct ? 'max_discount' : 'amount', amount };
}

/**
 * The breakdown of `amount` over a group's suborders: EQUAL shares, exactly
 * amount / n - never rounded (owner, 2026-11-11). Null for fewer than two
 * suborders: that is not a split.
 */
export function buildOrderBreakdown(
  group: Pick<OrderGroup, 'masterId' | 'suborders'>,
  basis: { basis: OrderBreakdown['basis']; amount: number },
): OrderBreakdown | null {
  const subs = group.suborders.filter((s) => s.orderId && s.orderId !== group.masterId);
  if (subs.length < 2 || !(basis.amount > 0)) return null;
  const share = basis.amount / subs.length;
  return {
    master_order_id: group.masterId,
    basis: basis.basis,
    amount: basis.amount,
    lines: subs.map((s) => ({
      order_id: s.orderId,
      restaurant_id: s.restaurantId,
      brand_id: s.brandId,
      restaurant_name: s.restaurantName,
      brand_name: s.brandName,
      share,
    })),
  };
}

/**
 * Is this group order really THIS customer's? The order number on a coupon is
 * typed by hand, and for Dine-in/Takeout it is the restaurant's own number -
 * which can be some stranger's Yiji order (OPS-NDYVFZZK, 2026-10). A group is
 * applied only when the master's customer is the coupon's customer.
 */
export function groupBelongsTo(
  group: Pick<OrderGroup, 'customerPhone'>,
  ...phones: Array<string | null | undefined>
): boolean {
  const owner = normalizePhone(group.customerPhone);
  if (!owner) return false;
  return phones.some((p) => normalizePhone(p) === owner);
}

/** Every order number of the group: the master first, then its suborders. */
export function groupOrderIds(group: Pick<OrderGroup, 'masterId' | 'suborders'>): string[] {
  return [group.masterId, ...group.suborders.map((s) => s.orderId)].filter(
    (v, i, a) => !!v && a.indexOf(v) === i,
  );
}

/** What `collapseGroupOrders` needs from an order (structurally a `YijiOrder`). */
export interface GroupableOrder {
  orderId: string;
  groupRole?: 'master' | 'sub';
  groupMasterId?: string;
  brandName?: string;
  restaurantName?: string;
  total?: number;
}

/**
 * A customer's order list with each group order shown ONCE (owner,
 * 2026-11-11): Yiji lists the master AND every suborder as separate orders, so
 * one group order took both "recent order" slots in the inbox and invited a
 * second coupon on a suborder. A suborder whose master is in the list is folded
 * into it (`groupSuborders`); one whose master is not stays, marked as part of
 * a group. Order is kept.
 */
export function collapseGroupOrders<T extends GroupableOrder>(
  orders: readonly T[],
): Array<T & { groupSuborders?: T[] }> {
  const masters = new Set(
    orders.filter((o) => o.groupRole === 'master').map((o) => String(o.orderId)),
  );
  const subsOf = new Map<string, T[]>();
  for (const o of orders) {
    if (o.groupRole === 'sub' && o.groupMasterId && masters.has(o.groupMasterId)) {
      subsOf.set(o.groupMasterId, [...(subsOf.get(o.groupMasterId) ?? []), o]);
    }
  }
  const out: Array<T & { groupSuborders?: T[] }> = [];
  for (const o of orders) {
    if (o.groupRole === 'sub' && o.groupMasterId && masters.has(o.groupMasterId)) continue;
    const subs = o.groupRole === 'master' ? subsOf.get(String(o.orderId)) : undefined;
    out.push(subs?.length ? { ...o, groupSuborders: subs } : o);
  }
  return out;
}
