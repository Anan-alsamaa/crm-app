import { readItems } from '@directus/sdk';
import type { Logger } from 'pino';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  breakdownBasis,
  buildOrderBreakdown,
  groupBelongsTo,
  groupOrderIds,
  type OrderBreakdown,
  type YijiOrderGroupReader,
} from '@yiji/shared-types';
import { describeError } from '../lib/errors.js';

/**
 * GROUP ORDERS: ONE COUPON, ON THE MASTER (owner, 2026-11-11).
 *
 * Decided here, in the worker, because EVERY coupon reaches Yiji through it -
 * tickets, chats, Late Orders, the Yiji ticket API and replacements alike - so
 * no path can skip the rule. See `@yiji/shared-types` `order-group.ts`.
 *
 *  - The order number on the coupon is read on Yiji. If it is a group order of
 *    THIS customer, the coupon is linked to the MASTER (a suborder number is
 *    switched to its master) and the suborders are saved as the breakdown, in
 *    equal shares that are never rounded.
 *  - If another coupon already covers the same group order, this one is NOT
 *    sent: one coupon per group order.
 *  - A failed read never blocks a coupon: it goes as before, linked to the
 *    number that was entered (the order number is a reference, see
 *    coupon-push "EVERY COUPON IS GIVEN BY THE CUSTOMER'S PHONE NUMBER").
 */

export interface CouponGroupRow {
  id?: string;
  status?: string | null;
  discount_category?: string | null;
  coupon_value?: number | string | null;
  max_discount?: number | string | null;
  title?: string | null;
  customer_phone?: string | null;
  contact?: { phone?: string | null } | null;
  replaces?: string | null;
  date_created?: string | null;
}

export interface CouponGroupDecision {
  /** The order number to send to Yiji: the master for a group order. */
  linkOrderId: string | null;
  /** The master order, saved on the coupon. Null for an ordinary order. */
  groupOrderId: string | null;
  breakdown: OrderBreakdown | null;
  /** Another coupon already covers this group order - do not send this one. */
  coveredBy: { id: string; code: string | null } | null;
}

/** The coupons that count as "already covering" an order. */
interface OtherCoupon {
  id: string;
  coupon_code?: string | null;
  status?: string | null;
  yiji_push_error?: string | null;
  date_created?: string | null;
}

export async function resolveCouponGroup(args: {
  row: CouponGroupRow;
  id: string;
  orderId: string | null;
  directus: YijiDirectusClient;
  logger: Pick<Logger, 'info' | 'warn'>;
  readOrderGroup?: YijiOrderGroupReader | null;
}): Promise<CouponGroupDecision> {
  const { row, id, orderId, directus, logger, readOrderGroup } = args;
  const plain: CouponGroupDecision = {
    linkOrderId: orderId,
    groupOrderId: null,
    breakdown: null,
    coveredBy: null,
  };
  if (!readOrderGroup || !orderId || !/^\d+$/.test(orderId)) return plain;

  let group;
  try {
    group = await readOrderGroup(orderId);
  } catch (err) {
    logger.warn(
      { id, orderId, err: describeError(err) },
      'group order check failed - coupon sent linked to the entered order',
    );
    return plain;
  }
  if (!group) return plain;
  if (!groupBelongsTo(group, row.customer_phone, row.contact?.phone, row.title)) {
    logger.info(
      { id, orderId, masterId: group.masterId },
      "the entered order is another customer's group order - kept as a reference only",
    );
    return plain;
  }

  const ids = groupOrderIds(group);
  const others = (await directus.request(
    readItems(
      'coupon_approvals' as never,
      {
        fields: ['id', 'coupon_code', 'status', 'yiji_push_error', 'date_created'],
        filter: {
          _and: [
            { id: { _neq: id } },
            ...(row.replaces ? [{ id: { _neq: row.replaces } }] : []),
            { status: { _in: ['approved', 'assigned'] } },
            { replaced_by: { _null: true } },
            { delivery_excluded: { _neq: true } },
            {
              _or: [
                { removal_status: { _null: true } },
                { removal_status: { _in: ['used', 'failed'] } },
              ],
            },
            {
              _or: [
                { group_order_id: { _eq: group.masterId } },
                { order_id: { _in: ids } },
                { ticket: { order_id: { _in: ids } } },
              ],
            },
          ],
        },
        sort: ['date_created'],
        limit: 20,
      } as never,
    ),
  )) as unknown as OtherCoupon[];

  /*
   * Which coupon wins: one already on Yiji, or an approved one that is still
   * on its way and was raised EARLIER than this one. Two coupons approved
   * together must not block each other - the older one goes, the newer waits.
   */
  const mine = Date.parse(row.date_created ?? '') || Number.POSITIVE_INFINITY;
  const cover = (others ?? []).find(
    (o) =>
      o.status === 'assigned' ||
      (o.status === 'approved' &&
        !o.yiji_push_error &&
        (Date.parse(o.date_created ?? '') || Number.POSITIVE_INFINITY) < mine),
  );

  const basis = breakdownBasis(row);
  const breakdown = basis ? buildOrderBreakdown(group, basis) : null;
  if (orderId !== group.masterId) {
    logger.info(
      { id, orderId, masterId: group.masterId },
      'suborder entered - the coupon is linked to its group master',
    );
  }
  return {
    linkOrderId: group.masterId,
    groupOrderId: group.masterId,
    breakdown,
    coveredBy: cover ? { id: cover.id, code: cover.coupon_code ?? null } : null,
  };
}

/** The reason saved on a coupon that was not sent because of `coveredBy`. */
export function coveredGroupReason(masterId: string, by: { code: string | null }): string {
  return `not sent: group order ${masterId} is already compensated by ${by.code ?? 'another coupon'} - one coupon per group order`;
}
