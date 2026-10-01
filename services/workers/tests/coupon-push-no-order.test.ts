import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  processCouponPushJob,
  yijiCouponPayload,
  YIJI_COUPON_PATH,
  YIJI_COMPENSATION_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';

/**
 * GRANTING A COUPON WITH NO ORDER NUMBER (owner, 2026-09-30).
 *
 * Three real pending coupons could not be delivered because the complaint came
 * in over WhatsApp: no order, no ticket order, no Yiji id — only the phone an
 * agent typed. `CreateCouponUserFromOrder` genuinely cannot help, because it
 * resolves the customer FROM the order.
 *
 * `AddCompensationCoupon` can: it takes a `CouponUserVM` whose `orderId` is
 * nullable and identifies the customer by `userId` instead. Verified against the
 * live Swagger and admin API. This corrects a comment this codebase carried,
 * that Yiji had no lookup by phone and no order-less grant — both were wrong.
 *
 * The tests below are mostly about what must NOT happen: a coupon is money, a
 * grant is irreversible from our side, and the staging redirect must survive a
 * path that identifies people by id rather than by phone.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({ collection, id, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    collection,
    id,
    payload,
  }),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** A real WhatsApp compensation: no ticket order, no own order, no Yiji id. */
const NO_ORDER_ROW: CouponApprovalRow = {
  id: 'ca-no-order',
  status: 'approved',
  coupon_code: 'OPS-433RHNBB',
  coupon_value: '10.00000',
  coupon_percent: null,
  max_discount: '10.00000',
  usage_limit: '1',
  valid_from: '2026-09-30',
  valid_to: '2026-10-30',
  title: '0536418952',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'La Casa Pasta',
  restaurant_id: '204',
  item_name: null,
  no_other_discounts: false,
  reason: 'The customer complained that they did not receive the Pepsi.',
  customer_phone: null,
  contact: { id: 'k1', name: null, phone: '0536418952', external_customer_id: null },
  ticket: { order_id: null },
  order_id: null,
  yiji_coupon_user_id: null,
} as unknown as CouponApprovalRow;

const OK_BODY = {
  result: 1,
  exceptionMessage: '0',
  errorCode: null,
  errorMessages: {},
  extendedProperties: { CouponUserId: 21500 },
  transactionStatus: 0,
};

function deps(
  overrides: Partial<Parameters<typeof processCouponPushJob>[1]> = {},
  row: CouponApprovalRow = NO_ORDER_ROW,
) {
  const patches: unknown[] = [];
  const directus = {
    request: vi.fn(async (arg: unknown) => {
      if (arg && typeof arg === 'object' && 'payload' in (arg as Record<string, unknown>)) {
        patches.push((arg as { payload: unknown }).payload);
        return {};
      }
      return row;
    }),
  };
  const postCoupon = vi.fn(async () => OK_BODY);
  const calls: string[] = [];
  const findCustomer = vi.fn(async (phone: string) => {
    calls.push(phone);
    return 'yiji-user-abc';
  });
  return {
    directus,
    patches,
    postCoupon,
    findCustomer,
    lookedUp: calls,
    deps: {
      directus: directus as never,
      logger,
      postCoupon: postCoupon as never,
      findCustomer: findCustomer as never,
      yijiTenantId: '1',
      ...overrides,
    },
  };
}

const job = (id = 'ca-no-order') =>
  ({ data: { couponApprovalId: id } }) as Job<{ couponApprovalId: string }>;

describe('a coupon with no order', () => {
  it('is granted by USER when the phone resolves to a Yiji customer', async () => {
    const { deps: d, postCoupon, lookedUp } = deps();
    await expect(processCouponPushJob(job(), d)).resolves.toBe('delivered');
    expect(lookedUp).toEqual(['0536418952']);
    // The compensation endpoint, NOT the order one.
    expect(postCoupon.mock.calls[0]![0]).toBe(YIJI_COMPENSATION_COUPON_PATH);
  });

  /*
   * THE BODY IS THE `CouponUserVM` ITSELF, not the order wrapper. Sending the
   * wrapper would bury the customer and the terms a level too deep; Yiji would
   * answer 200 and grant nothing.
   */
  it('sends the CouponUserVM itself, not the order envelope', async () => {
    const { deps: d, postCoupon } = deps();
    await processCouponPushJob(job(), d);
    const body = postCoupon.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('couponUser');
    expect(body).toMatchObject({ userId: 'yiji-user-abc', couponCode: 'OPS-433RHNBB' });
    // And the terms the supervisor approved still travel with it.
    expect((body.coupon as Record<string, unknown>).discount).toBe(10);
  });

  /*
   * A WALK-IN WITH NO APP ACCOUNT IS AN ORDINARY OUTCOME — roughly a third of
   * this queue. It must be reported honestly and left visibly owed, never
   * resolved to the nearest customer.
   */
  it('stays approved when the phone belongs to nobody on Yiji', async () => {
    const {
      deps: d,
      postCoupon,
      patches,
    } = deps({
      findCustomer: (async () => null) as never,
    });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('no-order');
    expect(postCoupon).not.toHaveBeenCalled();
    expect(patches).toHaveLength(0);
  });

  it('stays approved when no lookup is configured at all', async () => {
    const { deps: d, postCoupon } = deps({ findCustomer: undefined });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('no-order');
    expect(postCoupon).not.toHaveBeenCalled();
  });

  /*
   * A FAILED LOOKUP IS NOT "THEY HAVE NO ACCOUNT". Recording `no-order` on a
   * timeout would park a coupon that is genuinely deliverable; throwing lets
   * BullMQ retry. Same reasoning as `yiji_push_error` versus a 502.
   */
  it('retries rather than giving up when the lookup fails', async () => {
    const { deps: d, postCoupon } = deps({
      findCustomer: (async () => {
        throw new Error('ETIMEDOUT');
      }) as never,
    });
    await expect(processCouponPushJob(job(), d)).rejects.toThrow(/customer lookup failed/i);
    expect(postCoupon).not.toHaveBeenCalled();
  });

  /*
   * THE MOST IMPORTANT ONE IN THIS FILE.
   *
   * Staging shares Yiji's PRODUCTION coupon API. This path identifies the
   * customer by `userId`, and Yiji resolves from the id — so looking up the REAL
   * customer on staging and sending their id beside the test handset's phone
   * would grant a coupon to a real stranger that we cannot revoke. The LOOKUP
   * itself must be redirected, not just the phone in the payload.
   */
  it('looks up the TEST handset on staging, never the real customer', async () => {
    const { deps: d, lookedUp, postCoupon } = deps({ redirectCouponsTo: '0537301009' });
    await processCouponPushJob(job(), d);
    expect(lookedUp).toEqual(['0537301009']);
    expect(lookedUp).not.toContain('0536418952');
    const body = postCoupon.mock.calls[0]![1] as Record<string, unknown>;
    // The id that was granted is the one resolved from the test number.
    expect(body.userId).toBe('yiji-user-abc');
    expect(String(body.customerPhone)).toContain('537301009');
  });

  /* An order-less coupon still records its receipt, like any other grant. */
  it('records the Yiji receipt on success', async () => {
    const { deps: d, patches } = deps();
    await processCouponPushJob(job(), d);
    expect(patches[0]).toMatchObject({ status: 'assigned', yiji_coupon_user_id: '21500' });
  });

  /* The withhold flag outranks this path too: it is checked before anything
     that could send, so an excluded row never even looks a customer up. */
  it('never looks anybody up for a withheld coupon', async () => {
    const {
      deps: d,
      findCustomer,
      postCoupon,
    } = deps({}, {
      ...NO_ORDER_ROW,
      delivery_excluded: true,
    } as unknown as CouponApprovalRow);
    await expect(processCouponPushJob(job(), d)).resolves.toBe('excluded');
    expect(findCustomer).not.toHaveBeenCalled();
    expect(postCoupon).not.toHaveBeenCalled();
  });
});

describe('a coupon WITH an order is unchanged', () => {
  const WITH_ORDER = {
    ...NO_ORDER_ROW,
    id: 'ca-1',
    ticket: { order_id: '1187929' },
    contact: { id: 'k1', name: 'Saad', phone: '+966500000000', external_customer_id: 'yiji-77' },
  } as unknown as CouponApprovalRow;

  /* The order endpoint resolves the customer itself, so no lookup may happen —
     an extra admin call on the money path is cost and risk for nothing. */
  it('uses the order endpoint and never looks the customer up', async () => {
    const { deps: d, postCoupon, findCustomer } = deps({}, WITH_ORDER);
    await expect(processCouponPushJob(job('ca-1'), d)).resolves.toBe('delivered');
    expect(findCustomer).not.toHaveBeenCalled();
    expect(postCoupon.mock.calls[0]![0]).toBe(YIJI_COUPON_PATH);
  });

  it('still wraps the body in the order envelope', async () => {
    const { deps: d, postCoupon } = deps({}, WITH_ORDER);
    await processCouponPushJob(job('ca-1'), d);
    const body = postCoupon.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toHaveProperty('couponUser');
    expect(body.orderId).toBe(1187929);
  });
});

describe('yijiCouponPayload shape by path', () => {
  it('returns the bare CouponUserVM when a compensation user is named', () => {
    const body = yijiCouponPayload(NO_ORDER_ROW, null, {
      compensationUserId: 'u-1',
    }) as Record<string, unknown>;
    expect(body).not.toHaveProperty('couponUser');
    expect(body.userId).toBe('u-1');
  });

  it('returns the order envelope when none is named', () => {
    const body = yijiCouponPayload(NO_ORDER_ROW) as Record<string, unknown>;
    expect(body).toHaveProperty('couponUser');
  });

  /* The two envelopes must carry IDENTICAL terms: the money a supervisor
     approved cannot depend on whether an order happened to be attached. */
  it('carries the same approved terms either way', () => {
    const bare = yijiCouponPayload(NO_ORDER_ROW, null, { compensationUserId: 'u-1' }) as Record<
      string,
      unknown
    >;
    const wrapped = yijiCouponPayload(NO_ORDER_ROW) as {
      couponUser: Record<string, unknown>;
    };
    const strip = (o: Record<string, unknown>) => {
      const { userId: _u, ...rest } = o;
      return rest;
    };
    expect(strip(bare)).toEqual(strip(wrapped.couponUser));
  });
});
