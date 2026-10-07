import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { processCouponPushJob, type CouponApprovalRow } from '../src/processors/coupon-push.js';

/**
 * A REFUSAL IS BELIEVED ONLY AFTER A READ-BACK (owner, 2026-10-07).
 *
 * OPS-54R27RS7: Yiji answered "Object reference not set to an instance of an
 * object." — and had already created the coupon and given it to the customer.
 * The CRM recorded a refusal; "Try again" would have sent it twice. Now the
 * customer's own coupons are read back first.
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

// The real one: a late-order coupon on order 1332965, no ticket, no contact.
const ROW = {
  id: '543e4ccb',
  status: 'approved',
  coupon_code: 'OPS-54R27RS7',
  coupon_value: 9,
  coupon_percent: null,
  max_discount: '9.00000',
  usage_limit: 1,
  valid_from: '2026-10-06',
  valid_to: '2026-11-17',
  title: null,
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'La Casa Pasta',
  restaurant_id: '205',
  item_name: null,
  no_other_discounts: false,
  reason: 'The branch was late in preparing the order',
  customer_phone: '0591295655',
  contact: null,
  ticket: null,
  order_id: '1332965',
  yiji_coupon_user_id: null,
  yiji_push_error: null,
  delivery_excluded: false,
} as unknown as CouponApprovalRow;

const ORDER = {
  userId: 'e076d4a7',
  customerPhone: '+966591295655',
  restaurantId: 205,
  brandId: 1,
  tenantId: 1,
};
const NULL_REF = Object.assign(new Error('refused'), {
  name: 'YijiRefusedError',
  status: 400,
  body: { result: 2, exceptionMessage: 'Object reference not set to an instance of an object.' },
});

function run(findUserCoupon?: (u: string, c: string) => Promise<unknown>) {
  const patches: Array<Record<string, unknown>> = [];
  const directus = {
    request: vi.fn(async (arg: unknown) => {
      if (arg && typeof arg === 'object' && 'payload' in (arg as object)) {
        patches.push((arg as { payload: Record<string, unknown> }).payload);
        return {};
      }
      return ROW;
    }),
  };
  const postCoupon = vi.fn(async () => {
    throw NULL_REF;
  });
  return {
    patches,
    outcome: processCouponPushJob(
      { data: { couponApprovalId: ROW.id } } as Job<{ couponApprovalId: string }>,
      {
        directus: directus as never,
        logger,
        postCoupon: postCoupon as never,
        readOrder: (async () => ORDER) as never,
        findCustomer: (async () => 'e076d4a7') as never,
        ...(findUserCoupon ? { findUserCoupon: findUserCoupon as never } : {}),
        yijiTenantId: '1',
      },
    ),
  };
}

describe('Yiji answered with an error', () => {
  it('records the coupon as DELIVERED when the customer holds it after all', async () => {
    const lookup = vi.fn(async () => ({ couponUserId: '26186', couponId: 74033 }));
    const { outcome, patches } = run(lookup);
    await expect(outcome).resolves.toBe('delivered');
    expect(lookup).toHaveBeenCalledWith('e076d4a7', 'OPS-54R27RS7');
    expect(patches.at(-1)).toMatchObject({
      status: 'assigned',
      yiji_coupon_user_id: '26186',
      yiji_push_error: null,
    });
  });

  it('records the refusal when the customer really does not hold it', async () => {
    const { outcome, patches } = run(async () => null);
    await expect(outcome).resolves.toBe('refused');
    expect(patches.at(-1)).toMatchObject({
      yiji_push_error: expect.stringContaining('Object reference'),
    });
    expect(patches.some((p) => p.status === 'assigned')).toBe(false);
  });

  it('changes nothing when the read-back itself fails — the refusal stands', async () => {
    const { outcome, patches } = run(async () => {
      throw new Error('yiji unavailable');
    });
    await expect(outcome).resolves.toBe('refused');
    expect(patches.some((p) => p.status === 'assigned')).toBe(false);
  });

  it('behaves exactly as before when no read-back is configured', async () => {
    const { outcome } = run();
    await expect(outcome).resolves.toBe('refused');
  });
});
