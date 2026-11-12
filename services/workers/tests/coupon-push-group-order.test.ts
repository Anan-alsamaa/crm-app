import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { OrderGroup } from '@yiji/shared-types';
import {
  processCouponPushJob,
  YIJI_COMPENSATION_COUPON_PATH,
  YIJI_UNASSIGNED_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';

/**
 * GROUP ORDERS: ONE COUPON, ON THE MASTER (owner, 2026-11-11).
 *
 * Real shapes: group order 1370742 (master) with suborders 1370743 (Okashi)
 * and 1370744 (Taker). An agent may type either suborder; the coupon must go
 * to Yiji linked to the master, with the suborders saved as an equal,
 * unrounded breakdown - and a group order that already has a coupon must not
 * get a second one.
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
  id: 'ca-group',
  status: 'approved',
  coupon_code: 'OPS-GROUP001',
  coupon_value: '32.00000',
  coupon_percent: null,
  max_discount: '32.00000',
  usage_limit: '1',
  total_discount_limit: '32.00000',
  valid_from: '2026-11-11',
  valid_to: '2026-12-11',
  title: '+966555000111',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'Okashi',
  restaurant_id: '183',
  item_name: null,
  no_other_discounts: false,
  reason: 'Wrong item',
  customer_phone: null,
  contact: { id: 'k1', name: null, phone: '0555000111', external_customer_id: null },
  ticket: { order_id: '1370743' },
  order_id: null,
  yiji_coupon_user_id: null,
  replaces: null,
  date_created: '2026-11-11T08:00:00.000Z',
} as unknown as CouponApprovalRow;

const GROUP: OrderGroup = {
  masterId: '1370742',
  enteredId: '1370743',
  restaurantGroupId: 12,
  customerPhone: '0555000111',
  suborders: [
    {
      orderId: '1370743',
      restaurantId: 183,
      brandId: 3,
      restaurantName: 'Qatif - C Front',
      brandName: 'Okashi',
    },
    {
      orderId: '1370744',
      restaurantId: 177,
      brandId: 1004,
      restaurantName: 'C Front',
      brandName: 'Taker',
    },
  ],
};

const OK_BODY = {
  result: 1,
  exceptionMessage: '0',
  errorCode: null,
  errorMessages: {},
  extendedProperties: { CouponUserId: 31999 },
  transactionStatus: 0,
};

function setup(
  opts: {
    row?: Partial<CouponApprovalRow>;
    group?: OrderGroup | null | Error;
    others?: Array<Record<string, unknown>>;
  } = {},
) {
  const row = { ...ROW, ...(opts.row ?? {}) } as CouponApprovalRow;
  const patches: Array<Record<string, unknown>> = [];
  const groupQueries: unknown[] = [];
  const directus = {
    request: vi.fn(async (arg: unknown) => {
      const a = arg as Record<string, unknown>;
      if ('payload' in a) {
        patches.push(a.payload as Record<string, unknown>);
        return {};
      }
      if ('opts' in a && !('id' in a)) {
        const o = a.opts as { fields?: string[]; filter?: unknown };
        // The "already covered?" read: the one asking for date_created.
        if (o.fields?.includes('date_created')) {
          groupQueries.push(o.filter);
          return opts.others ?? [];
        }
        return []; // the code-uniqueness read
      }
      return row;
    }),
  };
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const postCoupon = vi.fn(async (path: string, body: Record<string, unknown>) => {
    bodies.push({ path, body });
    return path === YIJI_UNASSIGNED_COUPON_PATH
      ? { result: 1, exceptionMessage: 'couponId 90001', extendedProperties: {} }
      : OK_BODY;
  });
  const readOrderGroup = vi.fn(async () => {
    if (opts.group instanceof Error) throw opts.group;
    return opts.group === undefined ? GROUP : opts.group;
  });
  const run = () =>
    processCouponPushJob(
      { data: { couponApprovalId: 'ca-group' } } as Job<{ couponApprovalId: string }>,
      {
        directus: directus as never,
        logger,
        postCoupon: postCoupon as never,
        findCustomer: vi.fn(async () => 'yiji-user-1') as never,
        readOrderGroup: readOrderGroup as never,
        yijiTenantId: '1',
      },
    );
  const grant = () => bodies.find((b) => b.path === YIJI_COMPENSATION_COUPON_PATH)?.body;
  const last = () => patches[patches.length - 1] ?? {};
  return { run, grant, last, patches, postCoupon, readOrderGroup, groupQueries };
}

describe('a coupon on a group order', () => {
  it('is linked to the MASTER when a suborder number was entered', async () => {
    const t = setup();
    expect(await t.run()).toBe('delivered');
    expect(t.readOrderGroup).toHaveBeenCalledWith('1370743');
    expect(t.grant()?.orderId).toBe(1370742);
  });

  it('saves the master and an equal, unrounded breakdown on the suborders (32 -> 16 + 16)', async () => {
    const t = setup();
    await t.run();
    const p = t.last();
    expect(p.status).toBe('assigned');
    expect(p.group_order_id).toBe('1370742');
    const b = p.order_breakdown as {
      amount: number;
      basis: string;
      lines: Array<{ order_id: string; share: number }>;
    };
    expect(b.basis).toBe('amount');
    expect(b.amount).toBe(32);
    expect(b.lines.map((l) => [l.order_id, l.share])).toEqual([
      ['1370743', 16],
      ['1370744', 16],
    ]);
  });

  it('never rounds a share: 10 over three suborders is exactly 10 / 3 each', async () => {
    const three: OrderGroup = {
      ...GROUP,
      suborders: [...GROUP.suborders, { ...GROUP.suborders[0]!, orderId: '1370745' }],
    };
    const t = setup({ group: three, row: { coupon_value: '10.00000' } as never });
    await t.run();
    const b = t.last().order_breakdown as { lines: Array<{ share: number }> };
    expect(b.lines.map((l) => l.share)).toEqual([10 / 3, 10 / 3, 10 / 3]);
  });

  it('is NOT sent when the group order already has a coupon on Yiji', async () => {
    const t = setup({ others: [{ id: 'other', coupon_code: 'OPS-FIRST', status: 'assigned' }] });
    expect(await t.run()).toBe('refused');
    expect(t.postCoupon).not.toHaveBeenCalled();
    expect(String(t.last().yiji_push_error)).toMatch(
      /group order 1370742 is already compensated by OPS-FIRST/,
    );
  });

  it('looks for the other coupon on the master AND every suborder', async () => {
    const t = setup();
    await t.run();
    const f = JSON.stringify(t.groupQueries[0]);
    for (const id of ['1370742', '1370743', '1370744']) expect(f).toContain(id);
  });

  it('two approved together: the OLDER goes, the newer is held back', async () => {
    const older = setup({
      others: [
        {
          id: 'newer',
          coupon_code: 'OPS-NEWER',
          status: 'approved',
          date_created: '2026-11-11T09:00:00Z',
        },
      ],
    });
    expect(await older.run()).toBe('delivered');
    const newer = setup({
      others: [
        {
          id: 'older',
          coupon_code: 'OPS-OLDER',
          status: 'approved',
          date_created: '2026-11-11T07:00:00Z',
        },
      ],
    });
    expect(await newer.run()).toBe('refused');
  });

  it('an approved coupon that FAILED on Yiji does not block the group', async () => {
    const t = setup({
      others: [
        {
          id: 'o',
          coupon_code: 'OPS-FAILED',
          status: 'approved',
          yiji_push_error: 'x',
          date_created: '2026-11-10T00:00:00Z',
        },
      ],
    });
    expect(await t.run()).toBe('delivered');
  });

  it("another customer's group order is a reference only: the entered number, no breakdown", async () => {
    const t = setup({ group: { ...GROUP, customerPhone: '0500000000' } });
    expect(await t.run()).toBe('delivered');
    expect(t.grant()?.orderId).toBe(1370743);
    expect(t.last().group_order_id).toBeUndefined();
    expect(t.last().order_breakdown).toBeUndefined();
  });

  it('an ordinary order is unchanged', async () => {
    const t = setup({ group: null, row: { ticket: { order_id: '1372248' } } as never });
    expect(await t.run()).toBe('delivered');
    expect(t.grant()?.orderId).toBe(1372248);
    expect(t.last().group_order_id).toBeUndefined();
  });

  it('a failed group read never blocks the coupon: it goes with the entered number', async () => {
    const t = setup({ group: new Error('yiji down') });
    expect(await t.run()).toBe('delivered');
    expect(t.grant()?.orderId).toBe(1370743);
  });
});

/* ONE COUPON, ONE GRANT (2026-11-11): on staging two pushes of OPS-HNXZRMZC ran
   at the same moment and the customer's wallet got the coupon twice. */
describe('a coupon is never granted twice', () => {
  const exists = () =>
    Object.assign(new Error('refused'), {
      name: 'YijiRefusedError',
      status: 400,
      body: {
        result: 2,
        exceptionMessage: "Message: Coupon with Code 'OPS-GROUP001' already exists!",
      },
    });

  it('a second push while one is running steps aside: nothing is sent', async () => {
    const t = setup({ group: null, row: { ticket: { order_id: '1372248' } } as never });
    const lock = { acquire: vi.fn(async () => false), release: vi.fn(async () => {}) };
    const out = await processCouponPushJob(
      { data: { couponApprovalId: 'ca-group' } } as Job<{ couponApprovalId: string }>,
      {
        directus: { request: vi.fn() } as never,
        logger,
        postCoupon: t.postCoupon as never,
        yijiTenantId: '1',
        lock,
      },
    );
    expect(out).toBe('busy');
    expect(t.postCoupon).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('the lock is released when the push finishes', async () => {
    const t = setup({ group: null, row: { ticket: { order_id: '1372248' } } as never });
    const lock = { acquire: vi.fn(async () => true), release: vi.fn(async () => {}) };
    const directus = {
      request: vi.fn(async () => ({ status: 'assigned', yiji_coupon_user_id: '1' })),
    };
    await processCouponPushJob(
      { data: { couponApprovalId: 'ca-group' } } as Job<{ couponApprovalId: string }>,
      {
        directus: directus as never,
        logger,
        postCoupon: t.postCoupon as never,
        yijiTenantId: '1',
        lock,
      },
    );
    expect(lock.acquire).toHaveBeenCalledWith('coupon-change:ca-group', expect.any(Number));
    expect(lock.release).toHaveBeenCalledWith('coupon-change:ca-group');
  });

  it('"already exists" and the customer already holds it: recorded, NOT attached again', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const directus = {
      request: vi.fn(async (arg: unknown) => {
        const a = arg as Record<string, unknown>;
        if ('payload' in a) {
          patches.push(a.payload as Record<string, unknown>);
          return {};
        }
        if ('opts' in a && !('id' in a)) return [];
        return { ...ROW, ticket: { order_id: null }, order_id: null };
      }),
    };
    const paths: string[] = [];
    const postCoupon = vi.fn(async (path: string) => {
      paths.push(path);
      if (path === YIJI_UNASSIGNED_COUPON_PATH) throw exists();
      return {};
    });
    const out = await processCouponPushJob(
      { data: { couponApprovalId: 'ca-group' } } as Job<{ couponApprovalId: string }>,
      {
        directus: directus as never,
        logger,
        postCoupon: postCoupon as never,
        findCustomer: vi.fn(async () => 'yiji-user-1') as never,
        findUserCoupon: vi.fn(async () => ({ couponUserId: '32078', couponId: 89126 })) as never,
        yijiTenantId: '1',
      },
    );
    expect(out).toBe('delivered');
    expect(paths.some((p) => p.includes('AddCouponToUserByCode'))).toBe(false);
    expect(patches.at(-1)).toMatchObject({ status: 'assigned', yiji_coupon_user_id: '32078' });
  });
});
