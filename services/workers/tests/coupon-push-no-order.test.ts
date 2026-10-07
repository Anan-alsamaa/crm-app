import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  processCouponPushJob,
  yijiCouponPayload,
  YIJI_COUPON_PATH,
  YIJI_COMPENSATION_COUPON_PATH,
  YIJI_COMPENSATION_COUPON_PATH_FORBIDDEN,
  YIJI_UNASSIGNED_COUPON_PATH,
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
  /*
   * TWO CALLS, TWO ANSWERS. The order-less grant CREATES the coupon
   * (`AddCoupon` → `couponId` in `exceptionMessage`) and then ATTACHES it
   * (`AddUserCoupon` → `CouponUserId`). A mock returning one canned body for
   * both would pass while the real two-step was broken.
   */
  const postCoupon = vi.fn(async (path: string) =>
    path === YIJI_UNASSIGNED_COUPON_PATH
      ? { result: 1, exceptionMessage: 'couponId 73900', extendedProperties: {} }
      : OK_BODY,
  );
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
    /* CREATE then ATTACH — `AddUserCoupon` attaches an EXISTING coupon, so a
       single call could never have worked. */
    expect(postCoupon.mock.calls[0]![0]).toBe(YIJI_UNASSIGNED_COUPON_PATH);
    expect(postCoupon.mock.calls[1]![0]).toBe(YIJI_COMPENSATION_COUPON_PATH);
  });

  /*
   * THE BODY IS THE `CouponUserVM` ITSELF, not the order wrapper. Sending the
   * wrapper would bury the customer and the terms a level too deep; Yiji would
   * answer 200 and grant nothing.
   */
  it('attaches by couponId, naming the customer', async () => {
    const { deps: d, postCoupon } = deps();
    await processCouponPushJob(job(), d);
    /* The ATTACH call: the id Yiji just minted, and who it is for. The nested
       `coupon` object belongs to the CREATE call and is not repeated here. */
    const body = postCoupon.mock.calls[1]![1] as Record<string, unknown>;
    expect(body).toMatchObject({
      couponId: 73900,
      userId: 'yiji-user-abc',
      couponCode: 'OPS-433RHNBB',
    });
    expect(body).not.toHaveProperty('couponUser');
    // And the CREATE call carried the approved money.
    const created = postCoupon.mock.calls[0]![1] as Record<string, unknown>;
    expect(created.discount).toBe(10);
  });

  /*
   * THE COUPON IT ATTACHES MUST BE REDEEMABLE (owner, 2026-10-06).
   *
   * This path created the coupon in the no-account shape — General, with the
   * TOTAL pool equal to the uses (1) — and then attached it to a customer: the
   * same reachLimit-1 fault that left 88 coupons unredeemable. No test looked
   * at what was created, which is how it went unnoticed. It is created as the
   * assigned coupon is: Private, pool 10000.
   */
  it('creates the coupon it attaches as Private with the full pool', async () => {
    const { deps: d, postCoupon } = deps();
    await processCouponPushJob(job(), d);
    const created = postCoupon.mock.calls[0]![1] as Record<string, unknown>;
    expect(created.type).toBe(1);
    expect(created.reachLimit).toBe(10000);
    expect(created.orderMaximum).toBe(1000000);
  });

  /*
   * A WALK-IN WITH NO APP ACCOUNT IS AN ORDINARY OUTCOME — roughly a third of
   * this queue. It must be reported honestly and left visibly owed, never
   * resolved to the nearest customer.
   *
   * AND IT IS SETTLED, SO IT IS RECORDED. The sweep selects rows that are
   * approved, unexcluded and carry no `yiji_push_error`; writing nothing here
   * meant the coupon was re-examined every sweep — 60s by default — asking Yiji
   * the same question about the same number for ever. A number that resolves to
   * nobody today will not resolve in a minute.
   */
  /*
   * NO YIJI ACCOUNT YET: HELD, NOT CREATED (owner, 2026-10-07, EMA-49).
   *
   * It used to be created on Yiji UNASSIGNED, as a code the agent sent over
   * WhatsApp — redeemable by anyone who learned it, never tied to the number.
   * Now nothing reaches Yiji; the coupon waits in the CRM and the sweep looks
   * the number up again on a schedule until the customer signs up.
   */
  it('holds the coupon when the customer has no Yiji account', async () => {
    const { deps: d, postCoupon, patches } = deps({ findCustomer: (async () => null) as never });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('awaiting-signup');
    expect(postCoupon).not.toHaveBeenCalled();
    const patch = patches[0] as Record<string, unknown>;
    expect(patch.awaiting_signup_at).toEqual(expect.any(String));
    expect(patch.signup_checked_at).toEqual(expect.any(String));
    // Still owed: no status change, no refusal recorded.
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('yiji_push_error');
  });

  it('keeps when the wait STARTED on every later look', async () => {
    const waiting = { ...NO_ORDER_ROW, awaiting_signup_at: '2026-10-01T10:00:00Z' };
    const { deps: d, patches } = deps(
      { findCustomer: (async () => null) as never },
      waiting as unknown as CouponApprovalRow,
    );
    await processCouponPushJob(job(), d);
    const patch = patches[0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('awaiting_signup_at');
    expect(patch.signup_checked_at).toEqual(expect.any(String));
  });

  it('delivers to the new account once the number resolves', async () => {
    const waiting = { ...NO_ORDER_ROW, awaiting_signup_at: '2026-10-01T10:00:00Z' };
    const { deps: d, postCoupon } = deps({}, waiting as unknown as CouponApprovalRow);
    await expect(processCouponPushJob(job(), d)).resolves.toBe('delivered');
    expect(postCoupon.mock.calls[1]![1]).toMatchObject({ userId: 'yiji-user-abc' });
  });

  /* An old assertion kept honest: nothing is created when there is nothing to
     act on, so a missing lookup still records nothing. */
  it('creates nothing when the customer could not be looked up', async () => {
    const { deps: d, postCoupon, patches } = deps({ findCustomer: undefined });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('no-order');
    expect(postCoupon).not.toHaveBeenCalled();
    expect(patches).toHaveLength(0);
  });

  /*
   * NOT SETTLED: nothing was asked. Without the admin credential there was no
   * lookup, so recording "no account" would park a coupon on a configuration
   * gap and a supervisor would have to clear it by hand after the credential
   * arrives.
   */
  it('records NOTHING when no lookup is configured', async () => {
    const { deps: d, patches } = deps({ findCustomer: undefined });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('no-order');
    expect(patches).toHaveLength(0);
  });

  /* NOT SETTLED either: a supervisor may yet add the number. */
  it('records NOTHING when the row has no phone to look up', async () => {
    const { deps: d, patches } = deps({}, {
      ...NO_ORDER_ROW,
      contact: null,
      customer_phone: null,
    } as unknown as CouponApprovalRow);
    await expect(processCouponPushJob(job(), d)).resolves.toBe('no-order');
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
    const body = postCoupon.mock.calls[1]![1] as Record<string, unknown>;
    // The id that was granted is the one resolved from the TEST number.
    expect(body.userId).toBe('yiji-user-abc');
  });

  /* An order-less coupon still records its receipt, like any other grant. */
  it('records the Yiji receipt on success', async () => {
    const { deps: d, patches } = deps();
    await processCouponPushJob(job(), d);
    expect(patches[0]).toMatchObject({ status: 'assigned', yiji_coupon_user_id: '21500' });
  });

  /* The withhold flag outranks this path too: a withheld coupon is CREATED
     unassigned (owner, 2026-10-06) but never looks a customer up and never
     reaches the grant endpoint. */
  it('never looks anybody up for a withheld coupon, and never grants it', async () => {
    const {
      deps: d,
      findCustomer,
      postCoupon,
    } = deps({}, {
      ...NO_ORDER_ROW,
      delivery_excluded: true,
    } as unknown as CouponApprovalRow);
    await expect(processCouponPushJob(job(), d)).resolves.toBe('withheld');
    expect(findCustomer).not.toHaveBeenCalled();
    expect(postCoupon.mock.calls.map((c) => c[0])).toEqual([YIJI_UNASSIGNED_COUPON_PATH]);
  });
});

/**
 * THE ENDPOINT OUR ACCOUNT IS ACTUALLY ALLOWED TO CALL.
 *
 * `AddCompensationCoupon` is the obvious choice by name and takes the identical
 * `CouponUserVM` — and it answers 403 for us, every time. `AddUserCoupon`
 * beside it answers in Yiji's own business vocabulary instead:
 *
 *     POST /api/CouponUser/AddCompensationCoupon  -> 403 Forbidden
 *     POST /api/CouponUser/AddUserCoupon          -> {"result":2,
 *                                "exceptionMessage":"User already have this coupon"}
 *
 * The CRM token carries the role claim `agent 1`, not an admin role, and the
 * 403s cluster on exactly the endpoints an agent is not trusted with. So this
 * was never one missing grant to chase — it is what the role permits, and this
 * is the endpoint inside it that does the job.
 */
describe('the order-less grant uses the permitted endpoint', () => {
  it('posts to AddUserCoupon, not AddCompensationCoupon', () => {
    expect(YIJI_COMPENSATION_COUPON_PATH).toBe('/api/CouponUser/AddUserCoupon');
  });

  it('keeps the forbidden path named, so the reason is not rediscovered', () => {
    expect(YIJI_COMPENSATION_COUPON_PATH_FORBIDDEN).toBe('/api/CouponUser/AddCompensationCoupon');
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
