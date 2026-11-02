import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  processCouponPushJob,
  YIJI_COMPENSATION_COUPON_PATH,
  YIJI_UNASSIGNED_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';
import {
  findMisuse,
  nationalPhone,
  riyadhDay,
  runCouponMisuseCheck,
  type CrmCouponRow,
} from '../src/processors/coupon-misuse-check.js';
import type { YijiCouponOrder } from '@yiji/shared-types';

/**
 * THE TWO COUPON SAFEGUARDS (owner, 2026-11-02).
 *
 * October 2026: CRM coupons created as General (29 Sep - 5 Oct) were shared
 * and redeemed by hundreds of other customers - OPS-KUFLUUKK alone 340 times
 * by 310 phones - and nobody knew for a month.
 *
 *   1. THE PRIVATE CHECK: a new coupon Yiji does not hold as Private is never
 *      given to the customer, and the Administrator is told.
 *   2. THE MISUSE CHECK: an order paid with a CRM coupon by anyone but its
 *      customer is reported to the Administrator the same day.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({ collection, id, opts }),
  readUsers: (opts: unknown) => ({ users: true, opts }),
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

/* ── 1. the Private check ─────────────────────────────────────────────────── */

const ROW = {
  id: 'ca-1',
  status: 'approved',
  coupon_code: 'OPS-TESTPRIV',
  coupon_value: '20.00000',
  coupon_percent: null,
  max_discount: '20.00000',
  usage_limit: '1',
  valid_from: '2026-11-02',
  valid_to: '2026-12-02',
  title: '0536418952',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'La Casa Pasta',
  restaurant_id: '204',
  item_name: null,
  no_other_discounts: false,
  reason: 'Missing item.',
  customer_phone: null,
  contact: { id: 'k1', name: null, phone: '0536418952', external_customer_id: null },
  ticket: { order_id: null },
  order_id: null,
  yiji_coupon_user_id: null,
} as unknown as CouponApprovalRow;

function pushDeps(savedType: number | null | 'throws' | 'absent') {
  const patches: Array<Record<string, unknown>> = [];
  const directus = {
    request: vi.fn(async (arg: unknown) => {
      if (arg && typeof arg === 'object' && 'payload' in (arg as Record<string, unknown>)) {
        patches.push((arg as { payload: Record<string, unknown> }).payload);
        return {};
      }
      return ROW;
    }),
  };
  const postCoupon = vi.fn(async (path: string) =>
    path === YIJI_UNASSIGNED_COUPON_PATH
      ? { result: 1, exceptionMessage: 'couponId 90001', extendedProperties: {} }
      : { result: 1, exceptionMessage: '0', extendedProperties: { CouponUserId: 30001 } },
  );
  const readCoupon = vi.fn(async (id: number) => {
    if (savedType === 'throws') throw new Error('yiji down');
    return { id, code: 'OPS-TESTPRIV', type: savedType as number | null };
  });
  const alertNotPrivate = vi.fn(async () => undefined);
  return {
    patches,
    postCoupon,
    readCoupon,
    alertNotPrivate,
    deps: {
      directus: directus as never,
      logger,
      postCoupon: postCoupon as never,
      findCustomer: vi.fn(async () => 'yiji-user-1') as never,
      yijiTenantId: '1',
      ...(savedType === 'absent' ? {} : { readCoupon, alertNotPrivate }),
    },
  };
}
const job = () => ({ data: { couponApprovalId: 'ca-1' } }) as Job<{ couponApprovalId: string }>;

describe('the Private check on a new coupon', () => {
  it('gives a Private coupon to the customer and keeps its Yiji id', async () => {
    const t = pushDeps(1);
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('delivered');
    expect(t.readCoupon).toHaveBeenCalledWith(90001);
    expect(t.postCoupon.mock.calls.map((c) => c[0])).toEqual([
      YIJI_UNASSIGNED_COUPON_PATH,
      YIJI_COMPENSATION_COUPON_PATH,
    ]);
    expect(t.patches.at(-1)).toMatchObject({
      status: 'assigned',
      yiji_coupon_user_id: '30001',
      yiji_coupon_id: '90001',
    });
    expect(t.alertNotPrivate).not.toHaveBeenCalled();
  });

  it('NEVER gives a General coupon to the customer, records why and tells the Administrator', async () => {
    const t = pushDeps(0);
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('refused');
    // Created, read back, and NOT attached.
    expect(t.postCoupon.mock.calls.map((c) => c[0])).toEqual([YIJI_UNASSIGNED_COUPON_PATH]);
    const patch = t.patches.at(-1)!;
    expect(patch).not.toHaveProperty('status');
    expect(patch.yiji_coupon_id).toBe('90001');
    expect(String(patch.yiji_push_error)).toMatch(/General.*NOT given to the customer/);
    expect(t.alertNotPrivate).toHaveBeenCalledWith(
      'OPS-TESTPRIV',
      expect.stringMatching(/General/),
    );
  });

  it('a type Yiji cannot tell us is not Private either', async () => {
    const t = pushDeps(null);
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('refused');
    expect(t.postCoupon).toHaveBeenCalledTimes(1);
  });

  it('a read that FAILS does not hold back a coupon the customer is owed', async () => {
    const t = pushDeps('throws');
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('delivered');
    expect(t.postCoupon).toHaveBeenCalledTimes(2);
  });

  it('without a reader the push behaves exactly as before', async () => {
    const t = pushDeps('absent');
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('delivered');
    expect(t.postCoupon).toHaveBeenCalledTimes(2);
  });
});

/* ── 2. the misuse check ──────────────────────────────────────────────────── */

const CRM: CrmCouponRow[] = [
  // OPS-KUFLUUKK as it really was: given to 0536150460, grant 23000, coupon 73922.
  {
    id: 'r1',
    coupon_code: 'OPS-KUFLUUKK',
    title: '0536150460',
    yiji_coupon_user_id: '23000',
    yiji_coupon_id: null,
    yiji_pushed_at: '2026-10-02T00:00:00Z',
  },
  // A recent coupon whose Yiji id the CRM knows.
  {
    id: 'r2',
    coupon_code: 'OPS-NEWONE01',
    title: '+966501112222',
    yiji_coupon_user_id: '31000',
    yiji_coupon_id: '90100',
    yiji_pushed_at: '2026-11-02T10:00:00Z',
  },
];

const order = (o: Partial<YijiCouponOrder>): YijiCouponOrder => ({
  orderId: '1',
  couponGrantId: '1',
  couponId: 1,
  userId: 'u',
  phone: null,
  discount: 10,
  orderStatus: 'Closed',
  placedAt: '2026-11-02T12:00:00',
  ...o,
});

describe('findMisuse', () => {
  const codes = new Map([
    [73922, 'OPS-KUFLUUKK'],
    [5000, 'MARKETING-PROMO'],
  ]);

  it('flags another customer using a CRM code (another copy, another phone)', () => {
    const f = findMisuse(
      [
        order({
          orderId: '1360147',
          couponGrantId: '25861',
          couponId: 73922,
          phone: '+966570000001',
        }),
      ],
      CRM,
      codes,
    );
    expect(f).toEqual([
      expect.objectContaining({ kind: 'misuse', code: 'OPS-KUFLUUKK', detail: 'order 1360147' }),
    ]);
  });

  it('never flags the customer it was given to - by the CRM copy, or by phone', () => {
    expect(
      findMisuse(
        [order({ couponGrantId: '23000', couponId: 73922, phone: '+966599999999' })],
        CRM,
        codes,
      ),
    ).toEqual([]);
    expect(
      findMisuse(
        [order({ couponGrantId: '99999', couponId: 73922, phone: '+966536150460' })],
        CRM,
        codes,
      ),
    ).toEqual([]);
  });

  it('ignores coupons that are not the CRM’s (marketing codes are meant for many)', () => {
    expect(
      findMisuse(
        [order({ couponGrantId: '1', couponId: 5000, phone: '+966570000001' })],
        CRM,
        codes,
      ),
    ).toEqual([]);
    expect(findMisuse([order({ couponId: 4242, phone: '+966570000001' })], CRM, codes)).toEqual([]);
  });

  it('recognises a CRM coupon by its stored Yiji id without any read', () => {
    const f = findMisuse(
      [order({ orderId: '7', couponGrantId: '31999', couponId: 90100, phone: '0570000002' })],
      CRM,
      new Map(),
    );
    expect(f.map((x) => x.code)).toEqual(['OPS-NEWONE01']);
  });
});

describe('helpers', () => {
  it('reduces every phone shape to the national number', () => {
    for (const p of ['+966536150460', '0536150460', '536150460', '00966536150460'])
      expect(nationalPhone(p)).toBe('536150460');
  });
  it("uses Yiji's local day (Riyadh)", () => {
    expect(riyadhDay(new Date('2026-11-02T22:30:00Z'))).toBe('2026-11-03');
  });
});

describe('runCouponMisuseCheck', () => {
  function runDeps(opts: { orders: YijiCouponOrder[]; type?: number; redisHas?: boolean }) {
    const added: Array<{ name: string; data: Record<string, unknown> }> = [];
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, ..._rest: unknown[]) => {
        if (_rest.includes('NX') && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      }),
    };
    return {
      added,
      store,
      readCoupon: vi.fn(async (id: number) => ({
        id,
        code: id === 73922 ? 'OPS-KUFLUUKK' : `OTHER-${id}`,
        name: null,
        type: id === 90100 ? (opts.type ?? 1) : 0,
        status: 0,
        expirationDate: null,
      })),
      deps: {
        directus: { request: vi.fn(async () => CRM) } as never,
        notificationsQueue: {
          add: vi.fn(async (name: string, data: Record<string, unknown>) => {
            added.push({ name, data });
            return {} as never;
          }),
        },
        logger,
        readOrders: vi.fn(async () => opts.orders),
        redis,
        now: () => new Date('2026-11-03T06:00:00Z'),
        recipients: async () => ['admin-1'],
      },
    };
  }

  it('is off without a Yiji credential', async () => {
    const t = runDeps({ orders: [] });
    await expect(
      runCouponMisuseCheck({ ...t.deps, readOrders: null, readCoupon: null }),
    ).resolves.toMatchObject({ status: 'off' });
  });

  it('is quiet when every coupon order is the right customer and new coupons are Private', async () => {
    const t = runDeps({ orders: [order({ couponGrantId: '23000', couponId: 73922 })] });
    const r = await runCouponMisuseCheck({ ...t.deps, readCoupon: t.readCoupon });
    expect(r.status).toBe('clean');
    expect(t.added).toEqual([]);
  });

  it('tells the Administrator about misuse ONCE, however often it runs', async () => {
    const t = runDeps({
      orders: [
        order({ orderId: '1', couponGrantId: '25861', couponId: 73922, phone: '+966570000001' }),
        order({ orderId: '2', couponGrantId: '25862', couponId: 73922, phone: '+966570000002' }),
      ],
    });
    const first = await runCouponMisuseCheck({ ...t.deps, readCoupon: t.readCoupon });
    expect(first.status).toBe('alerted');
    expect(t.added).toHaveLength(1);
    expect(t.added[0]!.data).toMatchObject({
      recipientId: 'admin-1',
      title: 'Coupon used by the wrong customer',
    });
    expect(String(t.added[0]!.data.body)).toMatch(/OPS-KUFLUUKK x2/);
    // The coupon id was read once and cached.
    const second = await runCouponMisuseCheck({ ...t.deps, readCoupon: t.readCoupon });
    expect(second.status).toBe('already-alerted');
    expect(t.added).toHaveLength(1);
    expect(t.readCoupon.mock.calls.filter((c) => c[0] === 73922)).toHaveLength(1);
  });

  it('tells the Administrator when a new CRM coupon is not Private on Yiji', async () => {
    const t = runDeps({ orders: [], type: 0 });
    const r = await runCouponMisuseCheck({ ...t.deps, readCoupon: t.readCoupon });
    expect(r.status).toBe('alerted');
    expect(t.added[0]!.data.title).toBe('Coupon is not Private on Yiji');
    expect(String(t.added[0]!.data.body)).toMatch(/OPS-NEWONE01/);
  });

  it('an outage reading orders is not a finding', async () => {
    const t = runDeps({ orders: [] });
    const r = await runCouponMisuseCheck({
      ...t.deps,
      readCoupon: t.readCoupon,
      readOrders: vi.fn(async () => {
        throw new Error('yiji down');
      }),
    });
    expect(r.status).toBe('failed');
    expect(t.added).toEqual([]);
  });
});
