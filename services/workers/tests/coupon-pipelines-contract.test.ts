import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  processCouponPushJob,
  YIJI_COUPON_PATH,
  YIJI_COMPENSATION_COUPON_PATH,
  YIJI_UNASSIGNED_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';

/**
 * THE COUPON PIPELINES, END TO END — ONE CONTRACT, CHECKED ON EVERY BUILD.
 *
 * Owner, 2026-10-07: "all these issues should never happen again. These
 * processes should be verified on every release, as they're critical." Every
 * route a coupon takes to Yiji, with the exact API calls in order and EVERY
 * value the owner has fixed or named:
 *
 *   1a  assign, with an order   CreateCouponUserFromOrder (one call)
 *   1b  assign, no order        AddCoupon (create) -> AddUserCoupon (give it)
 *   2   create, don't assign    AddCoupon only, assignee [], never given
 *   3   customer not on Yiji    nothing created; held until they sign up
 *
 * The live counterpart is the COUPON-1a/1b/2 release checks, which read the
 * newest real coupon of each path back from Yiji.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({ collection, id, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({ collection, id, payload }),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const ROW = {
  id: 'ca-p',
  status: 'approved',
  coupon_code: 'OPS-PIPE1234',
  coupon_value: '30.00000',
  coupon_percent: null,
  max_discount: '30.00000',
  usage_limit: '1',
  valid_from: '2026-10-07',
  valid_to: '2026-11-07',
  title: '0502933330',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'La Casa Pasta',
  restaurant_id: '293',
  item_name: null,
  no_other_discounts: false,
  reason: 'The customer did not receive the chicken',
  customer_phone: null,
  contact: { id: 'k1', name: null, phone: '0502933330', external_customer_id: null },
  ticket: { order_id: null },
  order_id: null,
  yiji_coupon_user_id: null,
  yiji_push_error: null,
  delivery_excluded: false,
} as unknown as CouponApprovalRow;

const ORDER = {
  userId: 'yiji-user-1',
  customerPhone: '+966502933330',
  restaurantId: 293,
  brandId: 1,
  tenantId: 1,
};

async function run(row: CouponApprovalRow, customer: string | null = 'yiji-user-1') {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const patches: Array<Record<string, unknown>> = [];
  const directus = {
    request: vi.fn(async (arg: unknown) => {
      if (arg && typeof arg === 'object' && 'payload' in (arg as object)) {
        patches.push((arg as { payload: Record<string, unknown> }).payload);
        return {};
      }
      return row;
    }),
  };
  const postCoupon = vi.fn(async (path: string, body: unknown) => {
    calls.push({ path, body: body as Record<string, unknown> });
    if (path === YIJI_UNASSIGNED_COUPON_PATH)
      return { result: 1, exceptionMessage: 'couponId 73900', extendedProperties: {} };
    return { result: 1, exceptionMessage: '0', extendedProperties: { CouponUserId: 21500 } };
  });
  const outcome = await processCouponPushJob(
    { data: { couponApprovalId: row.id } } as Job<{ couponApprovalId: string }>,
    {
      directus: directus as never,
      logger,
      postCoupon: postCoupon as never,
      readOrder: (async () => ORDER) as never,
      findCustomer: (async () => customer) as never,
      yijiTenantId: '1',
    },
  );
  return { outcome, calls, patches };
}

/** Every value the owner has fixed or named, on the coupon definition itself. */
function expectOwnerValues(coupon: Record<string, unknown>) {
  expect(coupon.name).toBe('+966502933330'); // the customer's number, +966
  expect(coupon.code).toBe('OPS-PIPE1234');
  expect(coupon.type).toBe(1); // Private, as the agent chose
  expect(coupon.category).toBe(1); // Amount
  expect(coupon.discount).toBe(30);
  expect(coupon.discountPercentage).toBe(0);
  expect(coupon.maximumDiscount).toBe(30);
  expect(coupon.reachLimit).toBe(10000); // fixed
  expect(coupon.orderMaximum).toBe(1000000); // fixed
  expect(coupon.orderMinimum).toBe(0);
  expect(coupon.limitForUser).toBe(1); // the number of uses
  expect(coupon.monthlyReachLimit).toBe(1);
  for (const day of ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
    expect(coupon[day]).toBe(true);
  expect(coupon.compensationReason).toBe('CRM - The customer did not receive the chicken');
  expect(coupon.issuingSideId).toBe(6); // Operations
}

describe('1a — assign, with an order: CreateCouponUserFromOrder', () => {
  it('makes exactly one call, carrying every owner value, and records the receipt', async () => {
    const { outcome, calls, patches } = await run({
      ...ROW,
      order_id: '1330455',
    } as CouponApprovalRow);
    expect(outcome).toBe('delivered');
    expect(calls.map((c) => c.path)).toEqual([YIJI_COUPON_PATH]);
    const cu = calls[0]!.body.couponUser as Record<string, unknown>;
    expect(cu.couponCode).toBe('OPS-PIPE1234');
    expectOwnerValues(cu.coupon as Record<string, unknown>);
    expect(patches.at(-1)).toMatchObject({ status: 'assigned', yiji_coupon_user_id: '21500' });
  });
});

describe('1b — assign, no order: AddCoupon then AddUserCoupon', () => {
  it('creates the coupon, then gives THAT coupon to THAT customer', async () => {
    const { outcome, calls, patches } = await run(ROW);
    expect(outcome).toBe('delivered');
    expect(calls.map((c) => c.path)).toEqual([
      YIJI_UNASSIGNED_COUPON_PATH,
      YIJI_COMPENSATION_COUPON_PATH,
    ]);
    expectOwnerValues(calls[0]!.body);
    expect(calls[1]!.body).toMatchObject({
      couponId: 73900, // the id AddCoupon just returned
      userId: 'yiji-user-1', // the customer found by phone
      couponCode: 'OPS-PIPE1234',
    });
    expect(patches.at(-1)).toMatchObject({ status: 'assigned' });
  });
});

describe("2 — create, don't assign: AddCoupon only", () => {
  it('creates it with every owner value, assigned to nobody, and never gives it', async () => {
    const { outcome, calls, patches } = await run({
      ...ROW,
      delivery_excluded: true,
    } as CouponApprovalRow);
    expect(outcome).toBe('withheld');
    expect(calls.map((c) => c.path)).toEqual([YIJI_UNASSIGNED_COUPON_PATH]);
    expectOwnerValues(calls[0]!.body);
    expect(calls[0]!.body.assignee).toEqual([]);
    expect(calls[0]!.body).not.toHaveProperty('userId');
    // Yiji's coupon id is kept; the request is NOT marked as given to anyone.
    expect(patches.at(-1)).toMatchObject({ yiji_coupon_id: '73900' });
    expect(patches.some((p) => p.status === 'assigned')).toBe(false);
  });
});

describe('3 — customer not on Yiji yet: held', () => {
  it('creates nothing on Yiji and starts the wait', async () => {
    const { outcome, calls, patches } = await run(ROW, null);
    expect(outcome).toBe('awaiting-signup');
    expect(calls).toEqual([]);
    expect(patches.at(-1)).toMatchObject({ signup_checked_at: expect.any(String) });
  });

  it('once they have signed up, goes through 1b exactly', async () => {
    const waiting = {
      ...ROW,
      awaiting_signup_at: '2026-10-07T08:00:00Z',
    } as unknown as CouponApprovalRow;
    const { outcome, calls } = await run(waiting);
    expect(outcome).toBe('delivered');
    expect(calls.map((c) => c.path)).toEqual([
      YIJI_UNASSIGNED_COUPON_PATH,
      YIJI_COMPENSATION_COUPON_PATH,
    ]);
    expectOwnerValues(calls[0]!.body);
  });
});
