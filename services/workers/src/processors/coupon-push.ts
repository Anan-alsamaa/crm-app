import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { readItem, updateItem } from '@directus/sdk';
import type { CouponPushJob } from '@yiji/shared-types';
import { couponWindow } from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';

/**
 * Tell Yiji about a coupon a supervisor approved.
 *
 * Yiji owns the coupon that the customer can actually redeem; the CRM owns the
 * decision to grant one. This carries the second to the first, and moves the
 * request from `approved` to `assigned` once Yiji has it — which is exactly
 * what those two states have always meant.
 *
 * A job, not an inline call from the approval, because Yiji being down must
 * never make a supervisor's approval fail. The decision is recorded the moment
 * they make it and this delivers it afterwards, with retries.
 *
 * The job carries only an id: the coupon is re-read here, so terms amended by
 * the supervisor cannot be pushed as the agent originally asked for them, and a
 * request reversed between queueing and delivery is dropped rather than sent.
 */

export interface CouponPushDeps {
  directus: YijiDirectusClient;
  logger: Logger;
  /** Blank disables delivery — see `pushCoupon`. */
  yijiCouponUrl: string;
  yijiApiKey: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface CouponApprovalRow {
  id: string;
  status: string | null;
  coupon_code: string | null;
  coupon_value: number | string | null;
  coupon_percent: number | string | null;
  max_discount: number | string | null;
  usage_limit: number | string | null;
  valid_from: string | null;
  valid_to: string | null;
  title: string | null;
  issuing_side: string | null;
  delivery_type: string | null;
  coupon_type: string | null;
  discount_category: string | null;
  brand_id: string | null;
  restaurant_id: string | null;
  reason: string | null;
  contact: {
    name: string | null;
    phone: string | null;
    external_customer_id: string | null;
  } | null;
}

/** Postgres returns `numeric` as a string; Yiji is sent numbers. */
function num(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The body Yiji receives.
 *
 * ⚠ THE FIELD NAMES BELOW ARE NOT CONFIRMED AGAINST YIJI'S SPEC. Every value is
 * real and comes from the approved request, but what Yiji calls each one has to
 * be checked against their documentation before this is switched on. It is one
 * function on purpose: confirming the contract means editing this and nothing
 * else, and the test alongside it pins the values so a rename cannot quietly
 * change WHICH number is sent.
 *
 * Dates go as instants rather than the stored `YYYY-MM-DD`, through the same
 * `couponWindow` the rest of the system uses: a coupon runs for whole days, and
 * the end has to be the start of the following day or the last day is lost.
 */
export function yijiCouponPayload(row: CouponApprovalRow): Record<string, unknown> {
  const window = row.valid_from && row.valid_to ? couponWindow(row.valid_from, row.valid_to) : null;
  return {
    // The idempotency key. Yiji is asked to treat a repeat of the same code as
    // the same coupon, because a retry after a timeout must not grant twice.
    code: row.coupon_code,
    title: row.title,
    // Only one of the two is ever set — the category decides which.
    amount: num(row.coupon_value),
    percentage: num(row.coupon_percent),
    max_discount: num(row.max_discount),
    usage_limit: num(row.usage_limit) ?? 1,
    valid_from: window?.from ?? null,
    valid_to: window?.to ?? null,
    issuing_side: row.issuing_side,
    delivery_type: row.delivery_type,
    coupon_type: row.coupon_type,
    discount_category: row.discount_category,
    brand_id: row.brand_id,
    restaurant_id: row.restaurant_id,
    customer: {
      phone: row.contact?.phone ?? null,
      name: row.contact?.name ?? null,
      external_customer_id: row.contact?.external_customer_id ?? null,
    },
    reason: row.reason,
    source: 'sara-crm',
  };
}

/** What a push attempt concluded, for the log and the tests. */
export type PushOutcome = 'delivered' | 'disabled' | 'not-approved' | 'already-assigned';

export async function processCouponPushJob(
  job: Job<CouponPushJob>,
  deps: CouponPushDeps,
): Promise<PushOutcome> {
  const { directus, logger, yijiCouponUrl, yijiApiKey } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const id = job.data.couponApprovalId;

  const row = (await directus.request(
    readItem('coupon_approvals' as never, id, {
      fields: [
        'id',
        'status',
        'coupon_code',
        'coupon_value',
        'coupon_percent',
        'max_discount',
        'usage_limit',
        'valid_from',
        'valid_to',
        'title',
        'issuing_side',
        'delivery_type',
        'coupon_type',
        'discount_category',
        'brand_id',
        'restaurant_id',
        'reason',
        { contact: ['name', 'phone', 'external_customer_id'] },
      ],
    } as never),
  )) as unknown as CouponApprovalRow;

  // Re-read, so a decision reversed since queueing is honoured.
  if (row.status === 'assigned') {
    logger.info({ id }, 'coupon already assigned — nothing to push');
    return 'already-assigned';
  }
  if (row.status !== 'approved' && row.status !== 'edited') {
    logger.warn({ id, status: row.status }, 'coupon is not approved — refusing to push');
    return 'not-approved';
  }

  const payload = yijiCouponPayload(row);

  /**
   * No endpoint configured means no delivery, and the status stays `approved`.
   *
   * Deliberately not treated as success: marking it `assigned` would tell every
   * report that Yiji has a coupon it has never heard of, and the difference
   * between those two states is the only record of whether the customer can
   * actually redeem anything.
   */
  if (!yijiCouponUrl.trim()) {
    logger.info(
      { id, code: row.coupon_code, payload },
      'YIJI_COUPON_URL not set — coupon push is disabled, staying approved',
    );
    return 'disabled';
  }

  const res = await doFetch(yijiCouponUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(yijiApiKey ? { authorization: `Bearer ${yijiApiKey}` } : {}),
      // Same key across retries of the same job, so a timeout that actually
      // succeeded cannot become a second coupon.
      'idempotency-key': row.coupon_code ?? id,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Thrown, so BullMQ retries with backoff rather than swallowing it.
    throw new Error(`yiji coupon push failed (${res.status}): ${body.slice(0, 300)}`);
  }

  await directus.request(
    updateItem('coupon_approvals' as never, id, { status: 'assigned' } as never),
  );
  logger.info({ id, code: row.coupon_code }, 'coupon pushed to Yiji and marked assigned');
  return 'delivered';
}
