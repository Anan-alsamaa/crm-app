import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  processCouponPushJob,
  readCouponUserId,
  yijiCouponPayload,
  YIJI_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';

/*
 * These tests used to pin a GUESSED payload. Yiji had no published coupon API
 * when the push was written, so every field name was a placeholder and the
 * tests locked in the placeholder — which is worse than no test, because it
 * reads as a confirmed contract.
 *
 * The shape here comes from Yiji's own schema for
 * `CreateCouponUserFromOrder` and from a captured request that returned
 * `result: 1`. The endpoint attaches a coupon to ONE CUSTOMER on ONE ORDER,
 * which is exactly what this business grants.
 */

/*
 * The SDK's `updateItem` returns an opaque request function, so a spy on
 * `directus.request` cannot see WHAT was written. Mocked to a plain object so
 * the patch is inspectable — the receipt landing in the same write as the
 * status is the thing worth asserting.
 */
vi.mock('@directus/sdk', () => ({
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

const ROW: CouponApprovalRow = {
  id: 'ca-1',
  status: 'approved',
  coupon_code: 'OPS-ABC23456',
  // As Postgres actually returns numeric columns.
  coupon_value: '25.00000',
  coupon_percent: null,
  max_discount: '50.00000',
  usage_limit: '1',
  valid_from: '2026-08-18',
  valid_to: '2026-09-18',
  title: 'Sorry about your order',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'Casa Pasta',
  restaurant_id: 'store-4',
  item_name: null,
  reason: 'Order arrived cold.',
  contact: { name: 'Saad Al-Harbi', phone: '+966500000000', external_customer_id: 'yiji-77' },
  ticket: { order_id: '1187929' },
  yiji_coupon_user_id: null,
};

/** What Yiji sends back when it granted the coupon. */
const OK_BODY = {
  result: 1,
  exceptionMessage: '0',
  errorCode: null,
  errorMessages: {},
  extendedProperties: { CouponUserId: 21117 },
  transactionStatus: 0,
};

function deps(
  overrides: Partial<Parameters<typeof processCouponPushJob>[1]> = {},
  row: CouponApprovalRow = ROW,
) {
  const patches: unknown[] = [];
  const directus = {
    request: vi.fn(async (arg: unknown) => {
      // The update call carries a payload; the read does not.
      if (arg && typeof arg === 'object' && 'payload' in (arg as Record<string, unknown>)) {
        patches.push((arg as { payload: unknown }).payload);
        return {};
      }
      return row;
    }),
  };
  // Stands in for the service-account poster. Signing in is not this file's
  // concern — that lives in `createYijiAdminPoster`, next to the
  // status-history integration that shares the credential.
  const postCoupon = vi.fn(async () => OK_BODY);
  return {
    directus,
    patches,
    postCoupon,
    deps: {
      directus: directus as never,
      logger,
      postCoupon: postCoupon as never,
      yijiTenantId: '1',
      ...overrides,
    },
  };
}

const job = (id = 'ca-1') =>
  ({ data: { couponApprovalId: id } }) as Job<{ couponApprovalId: string }>;

describe('yijiCouponPayload', () => {
  it('sends the YIJI customer id when we hold one — never ours, never their phone', () => {
    // `userId` is the value Yiji issued for this customer. Sending our contact
    // id or their phone would be a value their side cannot resolve.
    const p = yijiCouponPayload(ROW) as { couponUser: Record<string, unknown> };
    expect(p.couponUser.userId).toBe('yiji-77');
  });

  it('omits userId entirely when we have no Yiji id, rather than sending a blank', () => {
    /*
     * The endpoint is `...FromOrder`: the ORDER identifies the customer, which
     * is why Yiji's own captured request carries no `userId` at all. Sending an
     * empty string instead would hand their resolver a value it has to
     * interpret, and 18 of the 19 approvals in this database have no Yiji id —
     * a blank would be the normal case, not the exception.
     */
    const p = yijiCouponPayload({
      ...ROW,
      contact: { ...ROW.contact!, external_customer_id: null },
    }) as { couponUser: Record<string, unknown> };
    expect(p.couponUser).not.toHaveProperty('userId');
    // The order still carries it.
    expect(p.couponUser.orderId).toBe(1187929);
  });

  it('carries the order in both places the schema names it', () => {
    // The endpoint attaches a coupon to an order; their schema repeats the id
    // at the top level and inside couponUser, so both are sent as NUMBERS —
    // `order_id` is stored as a string on the ticket.
    const p = yijiCouponPayload(ROW) as { orderId: unknown; couponUser: Record<string, unknown> };
    expect(p.orderId).toBe(1187929);
    expect(p.couponUser.orderId).toBe(1187929);
  });

  it('sends couponId 0 — Yiji resolves the coupon, we are not redeeming a catalogue entry', () => {
    const p = yijiCouponPayload(ROW) as { couponUser: Record<string, unknown> };
    expect(p.couponUser.couponId).toBe(0);
    // Our own code still goes, so the two systems can be matched from either
    // side afterwards.
    expect(p.couponUser.couponCode).toBe('OPS-ABC23456');
  });

  it('sends the reason under the field Yiji named for it', () => {
    const p = yijiCouponPayload(ROW) as { couponUser: Record<string, unknown> };
    expect(p.couponUser.compensationReason).toBe('Order arrived cold.');
  });

  it('identifies the customer for a Yiji-side reader too', () => {
    const p = yijiCouponPayload(ROW) as { couponUser: Record<string, unknown> };
    expect(p.couponUser.customerName).toBe('Saad Al-Harbi');
    expect(p.couponUser.customerPhone).toBe('+966500000000');
  });

  it('carries the approved TERMS, under the object their schema defines for them', () => {
    /*
     * `couponId: 0` means Yiji is not looking up a catalogue coupon it already
     * holds — it is creating one. So the terms the supervisor approved have to
     * travel with the request, or the customer receives whatever Yiji's default
     * happens to be while the CRM records 25 SAR.
     *
     * Money as a NUMBER: Postgres returns `numeric` columns as strings, and
     * "25.00000" in a JSON body is a different value to their parser.
     */
    const p = yijiCouponPayload(ROW) as {
      couponUser: { coupon: Record<string, unknown> };
    };
    expect(p.couponUser.coupon.discount).toBe(25);
    expect(p.couponUser.coupon.maximumDiscount).toBe(50);
    expect(p.couponUser.coupon.code).toBe('OPS-ABC23456');
    // A compensation coupon is a single grant.
    expect(p.couponUser.coupon.reachLimit).toBe(1);
    expect(p.couponUser.coupon.limitForUser).toBe(1);
  });

  it('sends only the discount kind that was actually approved', () => {
    // An amount coupon with `discountPercentage: 0` alongside it reads as "no
    // percentage discount" to some parsers and "0% off" to others. Neither is
    // what was approved, so the unused one is left off.
    const amount = yijiCouponPayload(ROW) as { couponUser: { coupon: Record<string, unknown> } };
    expect(amount.couponUser.coupon).not.toHaveProperty('discountPercentage');

    const pct = yijiCouponPayload({
      ...ROW,
      discount_category: 'Percentage',
      coupon_value: null,
      coupon_percent: '15',
    }) as { couponUser: { coupon: Record<string, unknown> } };
    expect(pct.couponUser.coupon.discountPercentage).toBe(15);
    expect(pct.couponUser.coupon).not.toHaveProperty('discount');
  });

  it('sends the validity window as instants that cover the final day in full', () => {
    // Stored as dates; a coupon valid "to 18 Sep" that expires at 00:00 on the
    // 18th is short by a day, and that is a support call.
    const p = yijiCouponPayload(ROW) as { couponUser: { coupon: Record<string, unknown> } };
    expect(p.couponUser.coupon.activationDate).toBe('2026-08-18T00:00:00.000Z');
    expect(p.couponUser.coupon.expirationDate).toBe('2026-09-19T00:00:00.000Z');
  });

  it('invents no field their schema does not define', () => {
    /*
     * Every key below appears in Yiji's schema for this endpoint. Inventing
     * names is how a payload starts claiming terms that were never agreed, and
     * a field their parser ignores is indistinguishable from one it honours.
     */
    const p = yijiCouponPayload(ROW) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(['couponUser', 'id', 'orderId', 'status', 'usedAmount']);
    for (const invented of ['brand_id', 'restaurant_id', 'valid_from', 'source']) {
      expect(p).not.toHaveProperty(invented);
    }
  });

  it('never sends OUR brand or branch ids, which are meaningless on their side', () => {
    /*
     * Their schema does have `brandId` and `restaurantId` — as numbers in THEIR
     * namespace. Ours are CRM values ("Casa Pasta", "store-4"). Sending them
     * would not merely be ignored: a number that happens to resolve would scope
     * the coupon to somebody else's brand or branch.
     */
    const p = yijiCouponPayload(ROW) as { couponUser: { coupon: Record<string, unknown> } };
    expect(p.couponUser.coupon).not.toHaveProperty('brandId');
    expect(p.couponUser.coupon).not.toHaveProperty('restaurantId');
  });
});

describe('readCouponUserId', () => {
  it('takes the id out of a granted response', () => {
    expect(readCouponUserId(OK_BODY)).toEqual({ ok: true, couponUserId: '21117' });
  });

  it('treats a 200 with a non-1 result as a refusal, and says why', () => {
    // Yiji answers 200 whether it granted or refused. Reading only the status
    // would mark a refused coupon assigned and tell every report the customer
    // can redeem something they cannot.
    const v = readCouponUserId({ result: 0, exceptionMessage: 'order not found' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/order not found/);
  });

  it('refuses a success that carries no id, because "assigned" would prove nothing', () => {
    const v = readCouponUserId({ result: 1, extendedProperties: {} });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/no CouponUserId/);
  });
});

describe('processCouponPushJob', () => {
  it('posts the coupon, stores the receipt and marks it assigned', async () => {
    const { deps: d, patches, postCoupon } = deps();
    await expect(processCouponPushJob(job(), d)).resolves.toBe('delivered');

    const call = postCoupon.mock.calls[0]! as unknown as [string, unknown, Record<string, string>];
    expect(call[0]).toBe(YIJI_COUPON_PATH);
    // Their API is multi-tenant and routes on this.
    expect(call[2].tenantid).toBe('1');
    // Stable across retries of the same job, so a timeout that in fact
    // succeeded cannot become a second coupon.
    expect(call[2]['idempotency-key']).toBe('OPS-ABC23456');

    // The receipt is written in the SAME patch as the status — a crash between
    // two writes would leave "assigned" with nothing to prove it.
    expect(patches[0]).toMatchObject({
      status: 'assigned',
      yiji_coupon_user_id: '21117',
    });
    expect(patches[0]).toHaveProperty('yiji_pushed_at');
  });

  it('retries a refusal rather than calling it delivered', async () => {
    const { deps: d, patches } = deps({
      postCoupon: vi.fn(async () => ({
        result: 0,
        exceptionMessage: 'coupon limit reached',
      })) as never,
    });
    // Thrown, so BullMQ retries with backoff. Exhausting the attempts leaves it
    // `approved`, which is the honest end state: the decision stands, the
    // delivery did not happen.
    await expect(processCouponPushJob(job(), d)).rejects.toThrow(/coupon limit reached/);
    expect(patches).toHaveLength(0);
  });

  it('will not push a coupon with no order to attach it to', async () => {
    // The endpoint attaches a coupon to an order. Without one Yiji answers 200
    // with a refusal, and the retry repeats it until the job gives up — a queue
    // full of failures whose real cause is a blank field on our side.
    const { deps: d, postCoupon } = deps({}, { ...ROW, ticket: { order_id: null } });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('no-order');
    expect(postCoupon).not.toHaveBeenCalled();
  });

  it('STILL pushes when the customer has no Yiji id — the order identifies them', async () => {
    /*
     * This is the regression that matters most here. An earlier version of this
     * processor refused to push without `external_customer_id`, which reads as
     * careful and would have silently held back 18 of the 19 approvals in this
     * database: every coupon for a complaint that arrived by phone or WhatsApp
     * rather than through the app. The endpoint resolves the customer from the
     * order, so the coupon goes.
     */
    const {
      deps: d,
      patches,
      postCoupon,
    } = deps({}, { ...ROW, contact: { ...ROW.contact!, external_customer_id: null } });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('delivered');
    expect(postCoupon).toHaveBeenCalled();
    expect(patches[0]).toMatchObject({ status: 'assigned', yiji_coupon_user_id: '21117' });
  });

  it('never sends a coupon Yiji has already taken', async () => {
    // The receipt is a stronger guard than the status: a retry after a timeout
    // that in fact succeeded would otherwise grant a second coupon.
    const { deps: d, postCoupon } = deps(
      {},
      { ...ROW, status: 'approved', yiji_coupon_user_id: '21117' },
    );
    await expect(processCouponPushJob(job(), d)).resolves.toBe('already-assigned');
    expect(postCoupon).not.toHaveBeenCalled();
  });

  it('does not claim delivery when no service credential is configured', async () => {
    /*
     * The distinction that matters: NOT CONFIGURED is not the same as failed,
     * and neither is success. The request stays `approved`, so the coupon is
     * still visibly owed to the customer — marking it `assigned` would tell
     * every report Yiji holds something it has never heard of.
     */
    const { deps: d, patches } = deps({ postCoupon: undefined });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('disabled');
    expect(patches).toHaveLength(0);
  });

  it('refuses to push a request that is not approved', async () => {
    const { deps: d, postCoupon } = deps({}, { ...ROW, status: 'rejected' });
    await expect(processCouponPushJob(job(), d)).resolves.toBe('not-approved');
    expect(postCoupon).not.toHaveBeenCalled();
  });

  it('throws on a transport failure so the job retries, and writes nothing', async () => {
    const { deps: d, patches } = deps({
      postCoupon: vi.fn(async () => {
        throw new Error('admin upstream 502 for /api/CouponUserOrder/CreateCouponUserFromOrder');
      }) as never,
    });
    await expect(processCouponPushJob(job(), d)).rejects.toThrow(/502/);
    // Nothing recorded: the decision stands, the delivery did not happen.
    expect(patches).toHaveLength(0);
  });
});
