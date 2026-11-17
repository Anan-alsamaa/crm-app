import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  processCouponPushJob,
  YIJI_UNASSIGNED_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';
import {
  alertGeneralCoupon,
  compensationFacts,
  generalCouponAlertText,
  isGeneralMarketingCoupon,
  loadCompensationFacts,
  loadMarketingFacts,
  marketingFacts,
  runGeneralCouponRequestAlert,
  type GeneralAlertRedis,
  type GeneralCouponAlertDeps,
} from '../src/processors/general-coupon-alert.js';

/**
 * EVERY GENERAL COUPON RAISES AN ALERT (owner, 17 Nov 2026): "any general
 * coupon created even on purpose should raise an alert." Requested, approved
 * and created on Yiji - once per coupon per stage - to the Administrators,
 * through the same channel as the Private-check alert. Private coupons never
 * alert, and nothing about the coupon itself changes.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ kind: 'list', collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({
    kind: 'one',
    collection,
    id,
    opts,
  }),
  readUsers: (opts: unknown) => ({ kind: 'users', opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    kind: 'update',
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

/** An in-memory Redis with SET NX / DEL. */
function fakeRedis() {
  const store = new Map<string, string>();
  const redis: GeneralAlertRedis = {
    set: vi.fn(async (k: string, v: string) => {
      if (store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
  };
  return { redis, store };
}

const ADMINS = ['admin-1', 'admin-2'];

function alertDeps(over: Partial<GeneralCouponAlertDeps> = {}) {
  const add = vi.fn(async () => ({}));
  const { redis, store } = fakeRedis();
  const deps: GeneralCouponAlertDeps = {
    directus: { request: vi.fn() } as never,
    notificationsQueue: { add } as never,
    logger,
    redis,
    recipients: async () => ADMINS,
    ...over,
  };
  return { deps, add, store };
}

const GENERAL_ROW = {
  id: 'ca-g',
  coupon_code: 'OPS-GENERAL1',
  coupon_type: 'General',
  discount_category: 'Amount',
  coupon_value: '50.00000',
  coupon_percent: null,
  max_discount: '50',
  customer_phone: '0536418952',
  title: 'Missing item',
  order_id: null,
  contact: null,
  ticket: { id: 't-77', subject: 'Cold food', order_id: '123456' },
  requested_by: { id: 'u-agent', first_name: 'Sara', last_name: 'Agent', email: 's@x' },
  user_created: null,
  decided_by: { id: 'u-sup', first_name: 'Omar', last_name: null, email: 'o@x' },
};

beforeEach(() => vi.clearAllMocks());

describe('the alert text', () => {
  it('names the code, creator, approver, value, phone, ticket and where to open it', () => {
    const facts = compensationFacts(GENERAL_ROW);
    const { title, body } = generalCouponAlertText(facts, 'approved');
    expect(title).toBe('General coupon approved: OPS-GENERAL1 is General');
    expect(body).toContain('OPS-GENERAL1');
    expect(body).toContain('Created by: Sara Agent.');
    expect(body).toContain('Approved by: Omar.');
    expect(body).toContain('Value: SAR 50.');
    expect(body).toContain('Customer phone: 0536418952.');
    expect(body).toContain('Ticket: t-77 "Cold food" order 123456.');
    expect(facts.link).toBe('/coupon-approvals');
  });

  it('a percentage shows its cap; a request not yet approved says so', () => {
    const facts = compensationFacts({
      ...GENERAL_ROW,
      discount_category: 'Percentage',
      coupon_percent: 20,
      max_discount: 30,
      decided_by: null,
      ticket: null,
    });
    const { body } = generalCouponAlertText(facts, 'requested');
    expect(body).toContain('Value: 20% (max SAR 30).');
    expect(body).toContain('Approved by: not yet.');
    expect(body).not.toContain('Ticket:');
  });

  it('a marketing coupon names its author and approver, and the Marketing portal', () => {
    const facts = marketingFacts({
      id: 'm1',
      code: 'MKT-AB12CD34',
      audience: 'code',
      discount_category: 'Amount',
      coupon_value: 20,
      user_created: { id: 'u-m', first_name: 'Lina', last_name: 'M' },
      decided_by: { id: 'u-mgr', email: 'mgr@x' },
    });
    const { title, body } = generalCouponAlertText(facts, 'created');
    expect(title).toBe('Marketing coupon created on Yiji: MKT-AB12CD34 is General');
    expect(body).toContain('Created by: Lina M.');
    expect(body).toContain('Approved by: mgr@x.');
    expect(body).toContain('Marketing portal');
    expect(facts.link).toBeNull();
  });

  it('only a list marketing coupon is Private', () => {
    expect(isGeneralMarketingCoupon({ audience: 'code' })).toBe(true);
    expect(isGeneralMarketingCoupon({ audience: null })).toBe(true);
    expect(isGeneralMarketingCoupon({ audience: 'list' })).toBe(false);
  });
});

describe('alertGeneralCoupon - once per coupon per stage', () => {
  it('tells every Administrator through the notifications queue, with a link', async () => {
    const t = alertDeps();
    const r = await alertGeneralCoupon(
      t.deps,
      { source: 'compensation', id: 'ca-g', stage: 'approved' },
      async () => compensationFacts(GENERAL_ROW),
    );
    expect(r).toBe('sent');
    expect(t.add).toHaveBeenCalledTimes(ADMINS.length);
    const [, data, opts] = (t.add.mock.calls[0] as unknown as [string, never, never])!;
    expect(data).toMatchObject({
      recipientId: 'admin-1',
      type: 'automation',
      link: '/coupon-approvals',
      payload: {
        kind: 'general_coupon',
        stage: 'approved',
        source: 'compensation',
        couponApprovalId: 'ca-g',
        codes: ['OPS-GENERAL1'],
      },
    });
    expect(opts).toEqual({
      jobId: 'coupon-alert-general-coupon-alert-compensation-ca-g-approved-admin-1',
    });
  });

  it('a repeat of the same stage sends nothing and reads nothing', async () => {
    const t = alertDeps();
    const load = vi.fn(async () => compensationFacts(GENERAL_ROW));
    const ref = { source: 'compensation' as const, id: 'ca-g', stage: 'approved' as const };
    await alertGeneralCoupon(t.deps, ref, load);
    await expect(alertGeneralCoupon(t.deps, ref, load)).resolves.toBe('already-alerted');
    expect(load).toHaveBeenCalledTimes(1);
    expect(t.add).toHaveBeenCalledTimes(ADMINS.length);
  });

  it('each stage alerts once on its own', async () => {
    const t = alertDeps();
    const load = async () => compensationFacts(GENERAL_ROW);
    for (const stage of ['requested', 'approved', 'created', 'created', 'approved'] as const) {
      await alertGeneralCoupon(t.deps, { source: 'compensation', id: 'ca-g', stage }, load);
    }
    expect(t.add).toHaveBeenCalledTimes(3 * ADMINS.length);
  });

  it('a send that fails frees the stage, so the next pass retries', async () => {
    const t = alertDeps({
      recipients: async () => {
        throw new Error('directus down');
      },
    });
    const ref = { source: 'compensation' as const, id: 'ca-g', stage: 'created' as const };
    const load = async () => compensationFacts(GENERAL_ROW);
    await expect(alertGeneralCoupon(t.deps, ref, load)).resolves.toBe('failed');
    expect(t.store.size).toBe(0);
    t.deps.recipients = async () => ADMINS;
    await expect(alertGeneralCoupon(t.deps, ref, load)).resolves.toBe('sent');
  });

  it('nobody to tell is not "sent" either - the stage stays open', async () => {
    const t = alertDeps({ recipients: async () => [] });
    const r = await alertGeneralCoupon(
      t.deps,
      { source: 'compensation', id: 'ca-g', stage: 'created' },
      async () => compensationFacts(GENERAL_ROW),
    );
    expect(r).toBe('no-recipient');
    expect(t.store.size).toBe(0);
  });

  it('a coupon that is not General after all frees the stage and sends nothing', async () => {
    const t = alertDeps();
    const r = await alertGeneralCoupon(
      t.deps,
      { source: 'compensation', id: 'ca-g', stage: 'approved' },
      async () => null,
    );
    expect(r).toBe('not-general');
    expect(t.add).not.toHaveBeenCalled();
    expect(t.store.size).toBe(0);
  });

  it('the loaders say "not General" for a Private compensation coupon and a list marketing coupon', async () => {
    const directus = {
      request: vi.fn(async (q: { collection: string }) =>
        q.collection === 'marketing_coupons'
          ? { id: 'm1', code: 'MKT-LIST0001', audience: 'list' }
          : { ...GENERAL_ROW, coupon_type: 'Private' },
      ),
    } as never;
    await expect(loadCompensationFacts(directus, 'ca-g')()).resolves.toBeNull();
    await expect(loadMarketingFacts(directus, 'm1')()).resolves.toBeNull();
  });
});

describe('the request-time sweep', () => {
  const PRIVATE_ROW = {
    ...GENERAL_ROW,
    id: 'ca-p',
    coupon_code: 'OPS-PRIV',
    coupon_type: 'Private',
  };
  const PUBLIC_ROW = {
    ...GENERAL_ROW,
    id: 'ca-pub',
    coupon_code: 'OPS-PUB',
    coupon_type: 'public',
  };
  /* `_icontains` lets this through; the shared exact-word rule does not. */
  const ODD_ROW = {
    ...GENERAL_ROW,
    id: 'ca-odd',
    coupon_code: 'OPS-ODD',
    coupon_type: 'Not general',
  };

  function sweepDeps(rows: unknown[], over: Partial<GeneralCouponAlertDeps> = {}) {
    const t = alertDeps(over);
    const request = vi.fn(async () => rows);
    t.deps.directus = { request } as never;
    return { ...t, request };
  }

  it('alerts each General/Public row once and never a Private one', async () => {
    const t = sweepDeps([GENERAL_ROW, PRIVATE_ROW, PUBLIC_ROW, ODD_ROW]);
    await expect(runGeneralCouponRequestAlert(t.deps)).resolves.toEqual({
      status: 'ok',
      general: 2,
      sent: 2,
    });
    const codes = t.add.mock.calls.map(
      (c) => (c as unknown as [string, { payload: { codes: string[] } }])[1].payload.codes[0],
    );
    expect(new Set(codes)).toEqual(new Set(['OPS-GENERAL1', 'OPS-PUB']));
    expect(t.add).toHaveBeenCalledTimes(2 * ADMINS.length);

    // The next run (2 minutes later) repeats nothing.
    await expect(runGeneralCouponRequestAlert(t.deps)).resolves.toMatchObject({ sent: 0 });
    expect(t.add).toHaveBeenCalledTimes(2 * ADMINS.length);
  });

  it('reads only General/Public rows created or changed in the last day', async () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const t = sweepDeps([], { now: () => now });
    await runGeneralCouponRequestAlert(t.deps);
    const q = (t.request.mock.calls[0] as unknown as [{ opts: { filter: unknown } }])[0];
    const filter = JSON.stringify(q.opts.filter);
    expect(filter).toContain('"coupon_type":{"_icontains":"general"}');
    expect(filter).toContain('"coupon_type":{"_icontains":"public"}');
    expect(filter).toContain('"date_updated":{"_gte":"2026-11-16T12:00:00.000Z"}');
    expect(filter).toContain('"date_created":{"_gte":"2026-11-16T12:00:00.000Z"}');
  });

  it('does not run without Redis - it would repeat every pass', async () => {
    const t = sweepDeps([GENERAL_ROW]);
    delete t.deps.redis;
    await expect(runGeneralCouponRequestAlert(t.deps)).resolves.toMatchObject({
      status: 'no-redis',
    });
    expect(t.request).not.toHaveBeenCalled();
    expect(t.add).not.toHaveBeenCalled();
  });

  it('a failed read is logged, not thrown', async () => {
    const t = sweepDeps([]);
    t.request.mockRejectedValueOnce(new Error('403'));
    await expect(runGeneralCouponRequestAlert(t.deps)).resolves.toMatchObject({
      status: 'failed',
    });
  });
});

/* ── the coupon push: approved + created on Yiji ─────────────────────────── */

const PUSH_ROW = {
  id: 'ca-1',
  status: 'approved',
  coupon_code: 'OPS-TESTGEN',
  coupon_value: '20.00000',
  coupon_percent: null,
  max_discount: '20.00000',
  usage_limit: '1',
  total_discount_limit: '10000.00000',
  valid_from: '2026-11-02',
  valid_to: '2026-12-02',
  title: '0536418952',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'General',
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

function pushDeps(
  row: Partial<CouponApprovalRow>,
  opts: {
    savedType?: number;
    alert?: (stage: 'approved' | 'created', id: string) => Promise<void>;
  } = {},
) {
  const full = { ...PUSH_ROW, ...row };
  const directus = {
    request: vi.fn(async (arg: { kind?: string }) => (arg?.kind === 'update' ? {} : full)),
  };
  const postCoupon = vi.fn(async (path: string) =>
    path === YIJI_UNASSIGNED_COUPON_PATH
      ? { result: 1, exceptionMessage: 'couponId 90001', extendedProperties: {} }
      : { result: 1, exceptionMessage: '0', extendedProperties: { CouponUserId: 30001 } },
  );
  const alertGeneralCoupon = vi.fn(opts.alert ?? (async () => undefined));
  return {
    directus,
    postCoupon,
    alertGeneralCoupon,
    deps: {
      directus: directus as never,
      logger,
      postCoupon: postCoupon as never,
      findCustomer: vi.fn(async () => 'yiji-user-1') as never,
      yijiTenantId: '1',
      ...(opts.savedType !== undefined
        ? {
            readCoupon: vi.fn(async (id: number) => ({ id, code: 'x', type: opts.savedType! })),
            alertNotPrivate: vi.fn(async () => undefined),
          }
        : {}),
      alertGeneralCoupon,
    },
  };
}
const job = () => ({ data: { couponApprovalId: 'ca-1' } }) as Job<{ couponApprovalId: string }>;

describe('the coupon push alerts on a General coupon', () => {
  it('approved, then created on Yiji - and the coupon is delivered unchanged', async () => {
    const t = pushDeps({});
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('delivered');
    expect(t.alertGeneralCoupon.mock.calls).toEqual([
      ['approved', 'ca-1'],
      ['created', 'ca-1'],
      ['created', 'ca-1'],
    ]);
    // Sent to Yiji as General, exactly as before this change.
    const created = t.postCoupon.mock.calls[0] as unknown as [string, { type: number }];
    expect(created[1].type).toBe(0);
  });

  it('"Public" is General too', async () => {
    const t = pushDeps({ coupon_type: 'Public' });
    await processCouponPushJob(job(), t.deps);
    expect(t.alertGeneralCoupon).toHaveBeenCalledWith('approved', 'ca-1');
  });

  it('created on Yiji is alerted even when the Private check then blocks it', async () => {
    const t = pushDeps({}, { savedType: 0 });
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('refused');
    expect(t.alertGeneralCoupon.mock.calls.map((c) => c[0])).toEqual(['approved', 'created']);
  });

  it('a withheld General coupon: approved, and created when Yiji made it', async () => {
    const t = pushDeps({ delivery_excluded: true });
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('withheld');
    expect(t.alertGeneralCoupon.mock.calls.map((c) => c[0])).toEqual(['approved', 'created']);
  });

  it('a Private coupon NEVER alerts, at any stage', async () => {
    for (const row of [
      { coupon_type: 'Private' },
      { coupon_type: 'private', delivery_excluded: true },
    ]) {
      const t = pushDeps(row as Partial<CouponApprovalRow>);
      await processCouponPushJob(job(), t.deps);
      expect(t.alertGeneralCoupon).not.toHaveBeenCalled();
    }
  });

  it('an alert that throws never blocks or changes the coupon', async () => {
    const t = pushDeps(
      {},
      {
        alert: async () => {
          throw new Error('redis down');
        },
      },
    );
    await expect(processCouponPushJob(job(), t.deps)).resolves.toBe('delivered');
    expect(t.postCoupon).toHaveBeenCalledTimes(2);
  });

  it('wired to the real alert: two pushes of the same coupon alert each stage once', async () => {
    const a = alertDeps();
    const t = pushDeps({});
    a.deps.directus = t.directus as never;
    const wire = (stage: 'approved' | 'created', id: string) =>
      alertGeneralCoupon(
        a.deps,
        { source: 'compensation', id, stage },
        loadCompensationFacts(a.deps.directus, id),
      ).then(() => undefined);
    t.deps.alertGeneralCoupon = vi.fn(wire);
    await processCouponPushJob(job(), t.deps);
    await processCouponPushJob(job(), t.deps);
    // approved + created, to each Administrator, once.
    expect(a.add).toHaveBeenCalledTimes(2 * ADMINS.length);
    const titles = a.add.mock.calls.map(
      (c) => (c as unknown as [string, { title: string }])[1].title,
    );
    expect(new Set(titles)).toEqual(
      new Set([
        'General coupon approved: OPS-TESTGEN is General',
        'General coupon created on Yiji: OPS-TESTGEN is General',
      ]),
    );
  });
});
