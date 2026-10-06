import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  crmCouponDescription,
  processCouponPushJob,
  runCouponDeliverySweep,
  yijiCouponPayload,
  YIJI_COUPON_PATH,
  YIJI_COMPENSATION_COUPON_PATH,
  YIJI_UNASSIGNED_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';

/**
 * WITHHELD COUPONS ARE CREATED ON YIJI, ASSIGNED TO NOBODY (owner, 2026-10-06).
 *
 * A coupon marked "do not send to the customer on the Yiji app" — the refund
 * customer — used to be skipped entirely, so Yiji never heard of it. It is now
 * created once via `AddCoupon`, Private with `assignee: []`, and its id is
 * recorded in `yiji_coupon_id`. It is never assigned.
 *
 * The owner's warning shapes the first block: "ensure all values are proper as
 * we faced a big issue before" (reachLimit 1 made 88 coupons unusable). So the
 * withheld body is pinned EQUAL to the assigned coupon, field by field, except
 * the two fields that make it belong to nobody.
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

const ROW: CouponApprovalRow = {
  id: 'ca-w',
  status: 'approved',
  coupon_code: 'CC-REFUND42',
  coupon_value: '25.00000',
  coupon_percent: null,
  max_discount: '25.00000',
  usage_limit: '1',
  valid_from: '2026-10-06',
  valid_to: '2026-11-06',
  title: null,
  issuing_side: 'Customer Care',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'Casa Pasta',
  restaurant_id: 'store-4',
  item_name: null,
  no_other_discounts: false,
  reason: 'Customer asked for a refund instead',
  customer_phone: null,
  contact: { id: 'k1', name: 'Saad', phone: '0508315325', external_customer_id: 'yiji-77' },
  ticket: { order_id: '1187929' },
  order_id: null,
  yiji_coupon_user_id: null,
  yiji_push_error: null,
  delivery_excluded: true,
  yiji_coupon_id: null,
};

const ORDER = {
  userId: '3e681e9e-2178-495b-8526-0bba25b17182',
  customerPhone: '+966508315325',
  customerName: 'Saad',
  restaurantId: 299,
  brandId: 1,
  tenantId: 1,
};

const CREATED = { result: 1, exceptionMessage: 'couponId 73900', extendedProperties: {} };

class RefusedError extends Error {
  name = 'YijiRefusedError';
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super('refused');
  }
}

function harness(
  row: CouponApprovalRow = ROW,
  overrides: Partial<Parameters<typeof processCouponPushJob>[1]> = {},
  opts: { failCouponIdRead?: boolean } = {},
) {
  const patches: Array<Record<string, unknown>> = [];
  const directus = {
    request: vi.fn(async (arg: unknown) => {
      const a = arg as { payload?: Record<string, unknown>; opts?: { fields?: unknown[] } };
      if (a && 'payload' in a) {
        patches.push(a.payload!);
        return {};
      }
      if (opts.failCouponIdRead && a?.opts?.fields?.[0] === 'yiji_coupon_id') {
        throw { errors: [{ message: 'You do not have permission to access this.' }] };
      }
      return row;
    }),
  };
  const postCoupon = vi.fn(
    async (_path: string, _body: unknown, _h?: unknown) => CREATED as unknown,
  );
  const readOrder = vi.fn(async () => ORDER);
  return {
    directus,
    patches,
    postCoupon,
    readOrder,
    deps: {
      directus: directus as never,
      logger,
      postCoupon: postCoupon as never,
      readOrder: readOrder as never,
      yijiTenantId: '1',
      ...overrides,
    },
  };
}

const job = () => ({ data: { couponApprovalId: 'ca-w' } }) as Job<{ couponApprovalId: string }>;

/** The ASSIGNED coupon object — what the order-based grant nests. */
const assignedCoupon = (row: CouponApprovalRow, order = ORDER as unknown, redirect?: string) =>
  (
    yijiCouponPayload(row, order as never, { redirectCouponsTo: redirect }) as {
      couponUser: { coupon: Record<string, unknown> };
    }
  ).couponUser.coupon;

const withheldBody = (row: CouponApprovalRow, order = ORDER as unknown, redirect?: string) =>
  yijiCouponPayload(row, order as never, { redirectCouponsTo: redirect, withheld: true });

const without = (o: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

describe('the withheld payload is the assigned coupon, minus its owner', () => {
  const variants: Array<[string, CouponApprovalRow, string | undefined]> = [
    ['a representative amount coupon', ROW, undefined],
    [
      'a percentage coupon with three uses and a strict-stacking rule',
      {
        ...ROW,
        discount_category: 'Percentage',
        coupon_value: null,
        coupon_percent: '15',
        usage_limit: '3',
        no_other_discounts: true,
        delivery_type: 'Delivery, Pickup',
      },
      undefined,
    ],
    [
      'a Public coupon (kept Public — the agent chose it)',
      { ...ROW, coupon_type: 'Public' },
      undefined,
    ],
    ['the staging redirect', ROW, '0537301009'],
    [
      'no dates and no reason',
      { ...ROW, valid_from: null, valid_to: null, reason: null },
      undefined,
    ],
  ];

  for (const [name, row, redirect] of variants) {
    /* Owner, 2026-10-06: the type is ALWAYS the agent's choice, so the
       withheld body equals the assigned coupon in every field, type included;
       only the (empty) assignee is added. */
    it(`is identical to the assigned coupon, plus an empty assignee — ${name}`, () => {
      const assigned = assignedCoupon(row, ORDER, redirect);
      const withheld = withheldBody(row, ORDER, redirect);
      expect(without(withheld, 'assignee')).toEqual(assigned);
      expect(withheld.assignee).toEqual([]);
    });
  }

  it('carries the fixed limits that once made 88 coupons unusable when wrong', () => {
    const w = withheldBody(ROW);
    expect(w.reachLimit).toBe(10000);
    expect(w.monthlyReachLimit).toBe(1);
    expect(w.limitForUser).toBe(1);
    expect(w.orderMinimum).toBe(0);
    expect(w.orderMaximum).toBe(1000000);
    expect(w.name).toBe('+966508315325');
    expect(w.code).toBe('CC-REFUND42');
    expect(w.compensation).toBe('CRM - Customer asked for a refund instead');
    expect(w.restaurantId).toBe(299);
    expect(w.brandId).toBe(1);
  });

  it('names NOBODY: no user id, no phone, no couponUser wrapper', () => {
    const w = withheldBody(ROW);
    expect(w).not.toHaveProperty('userId');
    expect(w).not.toHaveProperty('customerPhone');
    expect(w).not.toHaveProperty('couponUser');
    expect(w).not.toHaveProperty('orderId');
  });

  it('is named after the test handset on staging, never the real customer', () => {
    expect(withheldBody(ROW, ORDER, '0537301009').name).toBe('+966537301009');
  });

  /* Owner, 2026-10-06: type = the agent's choice, reachLimit = the fixed
     10000, on EVERY coupon — the no-account path included. */
  it('gives the no-account (unassigned) coupon the agent type and the fixed limits', () => {
    const u = yijiCouponPayload(ROW, null, { unassigned: true });
    expect(u.type).toBe(1); // ROW is Private
    expect(u.reachLimit).toBe(10000);
    expect(u.orderMaximum).toBe(1000000);
    expect(u.assignee).toEqual([]);
  });
});

describe('"CRM - " marks every coupon the CRM creates (owner, 2026-10-06)', () => {
  it('prefixes the reason', () => {
    expect(crmCouponDescription('Late delivery')).toBe('CRM - Late delivery');
  });
  it('never doubles it', () => {
    expect(crmCouponDescription('CRM - Late delivery')).toBe('CRM - Late delivery');
    expect(crmCouponDescription('crm - late')).toBe('crm - late');
  });
  it('says whose coupon it is even with no reason', () => {
    expect(crmCouponDescription('')).toBe('CRM - Compensation');
    expect(crmCouponDescription(null)).toBe('CRM - Compensation');
    expect(crmCouponDescription('   ')).toBe('CRM - Compensation');
  });
  it('lands in compensation AND compensationReason, on the coupon and the wrapper', () => {
    const p = yijiCouponPayload({ ...ROW, delivery_excluded: false }, ORDER) as {
      couponUser: Record<string, unknown> & { coupon: Record<string, unknown> };
    };
    expect(p.couponUser.compensationReason).toBe('CRM - Customer asked for a refund instead');
    expect(p.couponUser.coupon.compensationReason).toBe(
      'CRM - Customer asked for a refund instead',
    );
    expect(p.couponUser.coupon.compensation).toBe('CRM - Customer asked for a refund instead');
    // The NAME is untouched — it stays the customer's +966 number.
    expect(p.couponUser.couponName).toBe('+966508315325');
    expect(p.couponUser.coupon.name).toBe('+966508315325');
  });
  it('is on the order-less grant body (AddUserCoupon) too', async () => {
    const row = {
      ...ROW,
      delivery_excluded: false,
      ticket: { order_id: null },
      order_id: null,
    } as CouponApprovalRow;
    const h = harness(row, { findCustomer: vi.fn(async () => 'yiji-user-abc') as never });
    h.postCoupon.mockImplementation(async (path: string) =>
      path === YIJI_UNASSIGNED_COUPON_PATH
        ? CREATED
        : { result: 1, extendedProperties: { CouponUserId: 21500 } },
    );
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('delivered');
    const grant = h.postCoupon.mock.calls.find((c) => c[0] === YIJI_COMPENSATION_COUPON_PATH)!;
    expect((grant[1] as Record<string, unknown>).compensationReason).toBe(
      'CRM - Customer asked for a refund instead',
    );
  });
});

describe('processCouponPushJob — a withheld coupon', () => {
  it('creates it via AddCoupon, records yiji_coupon_id, and leaves it approved', async () => {
    const h = harness();
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('withheld');
    expect(h.postCoupon).toHaveBeenCalledTimes(1);
    const [path, body, headers] = h.postCoupon.mock.calls[0]!;
    expect(path).toBe(YIJI_UNASSIGNED_COUPON_PATH);
    expect(body).toMatchObject({ type: 1, assignee: [], reachLimit: 10000 });
    expect(headers).toMatchObject({ tenantid: '1', 'idempotency-key': 'withheld:CC-REFUND42' });
    expect(h.patches).toHaveLength(1);
    expect(h.patches[0]).toMatchObject({ yiji_coupon_id: '73900', yiji_push_error: null });
    // Status untouched (stays approved), and the "a customer holds it" column
    // is never borrowed for this.
    expect(h.patches[0]).not.toHaveProperty('status');
    expect(h.patches[0]).not.toHaveProperty('yiji_coupon_user_id');
  });

  it('never calls a grant endpoint', async () => {
    const h = harness();
    await processCouponPushJob(job(), h.deps);
    const paths = h.postCoupon.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain(YIJI_COUPON_PATH);
    expect(paths).not.toContain(YIJI_COMPENSATION_COUPON_PATH);
  });

  it('is created ONCE: an existing yiji_coupon_id means nothing is sent', async () => {
    const h = harness({ ...ROW, yiji_coupon_id: '73900' });
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('already-withheld');
    expect(h.postCoupon).not.toHaveBeenCalled();
    expect(h.patches).toHaveLength(0);
  });

  it('is never assigned later, even if the withhold box is unticked afterwards', async () => {
    const h = harness({ ...ROW, delivery_excluded: false, yiji_coupon_id: '73900' });
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('already-withheld');
    expect(h.postCoupon).not.toHaveBeenCalled();
  });

  it('records a duplicate code as a settled refusal (200 body), not a retry', async () => {
    const h = harness();
    h.postCoupon.mockResolvedValue({
      result: 2,
      exceptionMessage: "Message: Coupon with Code 'CC-REFUND42' already exists!",
    });
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('refused');
    expect(h.patches).toHaveLength(1);
    expect(String(h.patches[0]!.yiji_push_error)).toMatch(/already exists/);
    expect(h.patches[0]).not.toHaveProperty('yiji_coupon_id');
  });

  it('records a duplicate code delivered as HTTP 400 the same way', async () => {
    const h = harness();
    h.postCoupon.mockRejectedValue(
      new RefusedError(400, {
        result: 2,
        exceptionMessage: "Message: Coupon with Code 'CC-REFUND42' already exists!",
      }),
    );
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('refused');
    expect(String(h.patches[0]!.yiji_push_error)).toMatch(/already exists/);
  });

  it('retries an outage and writes nothing', async () => {
    const h = harness();
    h.postCoupon.mockRejectedValue(new Error('socket hang up'));
    await expect(processCouponPushJob(job(), h.deps)).rejects.toThrow(/socket hang up/);
    expect(h.patches).toHaveLength(0);
  });

  it('retries (and sends nothing) when yiji_coupon_id cannot be read', async () => {
    const h = harness(ROW, {}, { failCouponIdRead: true });
    await expect(processCouponPushJob(job(), h.deps)).rejects.toThrow(/yiji_coupon_id/);
    expect(h.postCoupon).not.toHaveBeenCalled();
  });

  it('does not let that unreadable column stop an ASSIGNED coupon', async () => {
    const h = harness({ ...ROW, delivery_excluded: false }, {}, { failCouponIdRead: true });
    h.postCoupon.mockResolvedValue({ result: 1, extendedProperties: { CouponUserId: 21117 } });
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('delivered');
  });

  it('is not created before it is approved', async () => {
    const h = harness({ ...ROW, status: 'pending' });
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('not-approved');
    expect(h.postCoupon).not.toHaveBeenCalled();
  });

  it('stays approved when no Yiji credential is configured', async () => {
    const h = harness(ROW, { postCoupon: undefined });
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('disabled');
    expect(h.patches).toHaveLength(0);
  });

  it('still creates it when the order cannot be read', async () => {
    const h = harness(ROW, {
      readOrder: vi.fn(async () => {
        throw new Error('order api down');
      }) as never,
    });
    await expect(processCouponPushJob(job(), h.deps)).resolves.toBe('withheld');
    const body = h.postCoupon.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('restaurantId');
    expect(body.name).toBe('+966508315325');
  });

  it('uses the staging redirect phone for the name', async () => {
    const h = harness(ROW, { redirectCouponsTo: '0537301009' });
    await processCouponPushJob(job(), h.deps);
    expect((h.postCoupon.mock.calls[0]![1] as Record<string, unknown>).name).toBe('+966537301009');
  });
});

describe('runCouponDeliverySweep — withheld coupons owed a creation', () => {
  function sweep(first: unknown[], second: unknown[] | Error) {
    const calls: Array<{ opts: { filter: Record<string, unknown> } }> = [];
    const directus = {
      request: vi.fn(async (arg: { opts: { filter: Record<string, unknown> } }) => {
        calls.push(arg);
        if (calls.length === 1) return first;
        if (second instanceof Error) throw second;
        return second;
      }),
    };
    const added: unknown[] = [];
    const couponsQueue = { add: vi.fn(async (_n: string, d: unknown) => void added.push(d)) };
    return { directus, couponsQueue, calls, added };
  }

  it('asks for approved, withheld rows with no yiji_coupon_id and no refusal', async () => {
    const s = sweep([], []);
    await runCouponDeliverySweep({
      directus: s.directus as never,
      logger,
      couponsQueue: s.couponsQueue as never,
    });
    expect(s.calls[1]!.opts.filter).toEqual({
      status: { _in: ['approved', 'edited'] },
      delivery_excluded: { _eq: true },
      yiji_coupon_id: { _null: true },
      yiji_push_error: { _null: true },
    });
    // The assignment query still keeps them out, for good.
    expect(s.calls[0]!.opts.filter).toMatchObject({ delivery_excluded: { _neq: true } });
  });

  it('enqueues both kinds, once each', async () => {
    const s = sweep([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'w' }]);
    const n = await runCouponDeliverySweep({
      directus: s.directus as never,
      logger,
      couponsQueue: s.couponsQueue as never,
    });
    expect(n).toBe(3);
    expect(s.added).toEqual([
      { couponApprovalId: 'a' },
      { couponApprovalId: 'b' },
      { couponApprovalId: 'w' },
    ]);
  });

  it('a failing withheld query (column not applied yet) never costs assigned delivery', async () => {
    const s = sweep([{ id: 'a' }], new Error('403'));
    const n = await runCouponDeliverySweep({
      directus: s.directus as never,
      logger,
      couponsQueue: s.couponsQueue as never,
    });
    expect(n).toBe(1);
  });
});
