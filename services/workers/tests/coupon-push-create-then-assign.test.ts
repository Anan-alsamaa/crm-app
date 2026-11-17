import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { YijiRefusedError } from '@yiji/shared-types';
import {
  processCouponPushJob,
  runCouponDeliverySweep,
  YIJI_ATTACH_BY_CODE_PATH,
  YIJI_COMPENSATION_COUPON_PATH,
  YIJI_UNASSIGNED_COUPON_PATH,
  type CouponPushDeps,
} from '../src/processors/coupon-push.js';
import { processCouponRemoveJob } from '../src/processors/coupon-remove.js';

/**
 * NO YIJI ACCOUNT: CREATE ON YIJI NOW, ASSIGN ON SIGNUP (owner, 17 Nov 2026).
 *
 *   "the moment a coupon is created and the customer is not on yiji, it must
 *    create the coupon in yiji by calling the api for coupon creation alone.
 *    when the customer signs into yiji, it can call the coupon assigning api
 *    for the customer."
 *
 * The REAL processor runs against a Directus fake that keeps the row's state
 * (every patch lands on it) and a Yiji fake that records every call. Nothing
 * here talks to Yiji or Directus.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ op: 'readItems', collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({
    op: 'readItem',
    collection,
    id,
    opts,
  }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    op: 'updateItem',
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

/** A WhatsApp compensation for a number with no Yiji account. */
const ROW = {
  id: 'ca-signup',
  status: 'approved',
  coupon_code: 'OPS-SGNP1234',
  coupon_value: '25.00000',
  coupon_percent: null,
  max_discount: '25.00000',
  usage_limit: '1',
  total_discount_limit: '25.00000',
  valid_from: '2026-11-17',
  valid_to: '2026-12-17',
  title: '0551234567',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'La Casa Pasta',
  restaurant_id: '204',
  item_name: null,
  no_other_discounts: false,
  reason: 'Late order',
  customer_phone: null,
  contact: { id: 'k1', name: null, phone: '0551234567', external_customer_id: null },
  ticket: { order_id: null },
  order_id: null,
  yiji_coupon_user_id: null,
  yiji_coupon_id: null,
  yiji_push_error: null,
  delivery_excluded: false,
  awaiting_signup_at: null,
  signup_checked_at: null,
  removal_status: null,
} as const;

type Call = { path: string; body: Record<string, unknown>; headers: Record<string, string> };

function harness(
  rowOver: Record<string, unknown> = {},
  opts: {
    /** Who the phone resolves to; null = no Yiji account. */
    customer?: string | null;
    /** Replace the fake Yiji's answer for a path. */
    answer?: (path: string, call: number) => unknown;
    /** The coupon type Yiji reads back (1 = Private). */
    savedType?: number;
    readCouponThrows?: boolean;
    /** What the customer's wallet holds (findUserCoupon). */
    holds?: boolean;
  } = {},
) {
  const state: Record<string, unknown> = { ...ROW, ...rowOver };
  const patches: Array<Record<string, unknown>> = [];
  const directus = {
    request: vi.fn(async (r: { op: string; payload?: Record<string, unknown> }) => {
      if (r.op === 'updateItem') {
        patches.push(r.payload!);
        Object.assign(state, r.payload);
        return {};
      }
      /* `codeIsOnlyThisRow` - no other row carries this code. */
      if (r.op === 'readItems') return [];
      return { ...state };
    }),
  };
  const calls: Call[] = [];
  let n = 0;
  const postCoupon = vi.fn(async (path: string, body: unknown, headers: Record<string, string>) => {
    calls.push({ path, body: body as Record<string, unknown>, headers });
    n += 1;
    if (opts.answer) {
      const a = opts.answer(path, n);
      if (a instanceof Error) throw a;
      if (a !== undefined) return a;
    }
    if (path === YIJI_UNASSIGNED_COUPON_PATH)
      return { result: 1, exceptionMessage: 'couponId 74100', extendedProperties: {} };
    return { result: 1, exceptionMessage: '0', extendedProperties: { CouponUserId: 33001 } };
  });
  const findCustomer = vi.fn(async () => (opts.customer === undefined ? null : opts.customer));
  const findUserCoupon = vi.fn(async () => (opts.holds ? { couponUserId: '33001' } : null));
  const readCoupon = vi.fn(async () => {
    if (opts.readCouponThrows) throw new Error('timeout');
    return { type: opts.savedType ?? 1, code: String(state.coupon_code) };
  });
  const alertNotPrivate = vi.fn(async () => undefined);
  const deps: CouponPushDeps = {
    directus: directus as never,
    logger,
    postCoupon: postCoupon as never,
    findCustomer: findCustomer as never,
    findUserCoupon: findUserCoupon as never,
    readCoupon,
    alertNotPrivate,
    yijiTenantId: '1',
  };
  const run = (over: Partial<CouponPushDeps> = {}) =>
    processCouponPushJob(
      { data: { couponApprovalId: String(state.id) } } as Job<{ couponApprovalId: string }>,
      { ...deps, ...over },
    );
  const paths = () => calls.map((c) => c.path);
  return {
    state,
    patches,
    calls,
    paths,
    run,
    postCoupon,
    findCustomer,
    findUserCoupon,
    readCoupon,
    alertNotPrivate,
  };
}

const refusedErr = (msg: string) =>
  new YijiRefusedError('refused', 400, { result: 2, exceptionMessage: msg });

describe('no Yiji account: created on Yiji now, never granted', () => {
  it('makes ONE creation call, no grant, and keeps the id with the watch', async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe('awaiting-signup');
    expect(h.paths()).toEqual([YIJI_UNASSIGNED_COUPON_PATH]);
    const body = h.calls[0]!.body;
    expect(body.type).toBe(1); // Private, as the agent chose - never General
    expect(body.assignee).toEqual([]); // nobody
    expect(body).not.toHaveProperty('userId');
    expect(body.name).toBe('+966551234567'); // the coupon name is the phone
    expect(body.code).toBe('OPS-SGNP1234');
    expect(h.calls[0]!.headers).toMatchObject({
      tenantid: '1',
      'idempotency-key': 'unassigned:OPS-SGNP1234',
    });
    expect(h.readCoupon).toHaveBeenCalledWith(74100); // the Private read-back
    expect(h.state).toMatchObject({
      status: 'approved', // nobody holds it
      yiji_coupon_id: '74100',
      yiji_coupon_user_id: null,
      yiji_push_error: null,
      awaiting_signup_at: expect.any(String),
      signup_checked_at: expect.any(String),
      yiji_pushed_at: expect.any(String),
    });
    /* One patch: the id and the watch together, never one without the other. */
    expect(h.patches).toHaveLength(1);
  });

  it('a re-run (sweep + approval click) never creates a second coupon', async () => {
    const h = harness();
    await h.run();
    await expect(h.run()).resolves.toBe('awaiting-signup');
    await expect(h.run()).resolves.toBe('awaiting-signup');
    expect(h.paths()).toEqual([YIJI_UNASSIGNED_COUPON_PATH]);
    expect(h.state.yiji_coupon_id).toBe('74100');
    expect(h.state.signup_checked_at).toEqual(expect.any(String));
  });

  it('a refusal is recorded exactly as today - settled, nothing granted', async () => {
    const h = harness({}, { answer: () => refusedErr('Invalid branch') });
    await expect(h.run()).resolves.toBe('refused');
    expect(h.paths()).toEqual([YIJI_UNASSIGNED_COUPON_PATH]);
    expect(String(h.state.yiji_push_error)).toMatch(
      /would not create the coupon: .*Invalid branch/,
    );
    expect(h.state.yiji_coupon_id).toBeNull();
    expect(h.state.status).toBe('approved');
  });

  it('a refusal in a 200 body (result != 1) is recorded too', async () => {
    const h = harness(
      {},
      { answer: () => ({ result: 2, exceptionMessage: 'Bad dates', extendedProperties: {} }) },
    );
    await expect(h.run()).resolves.toBe('refused');
    expect(String(h.state.yiji_push_error)).toMatch(/Bad dates/);
    expect(h.state.yiji_coupon_id).toBeNull();
  });

  it('an outage is retried (thrown), with nothing written', async () => {
    const h = harness(
      {},
      {
        answer: () => Object.assign(new Error('socket hang up'), { name: 'YijiUnavailableError' }),
      },
    );
    await expect(h.run()).rejects.toThrow(/socket hang up/);
    expect(h.patches).toHaveLength(0);
    expect(h.state.yiji_push_error).toBeNull();
  });

  it('"already exists" for this row\'s own code: stays watched, never parked', async () => {
    const h = harness(
      {},
      { answer: () => refusedErr('Coupon with Code OPS-SGNP1234 already exists!') },
    );
    await expect(h.run()).resolves.toBe('awaiting-signup');
    expect(h.state.yiji_push_error).toBeNull();
    expect(h.state.yiji_coupon_id).toBeNull();
    expect(h.state.awaiting_signup_at).toEqual(expect.any(String));
  });

  it('Yiji saves it as General: the id is kept, the row parked, the Administrator told', async () => {
    const h = harness({}, { savedType: 0 });
    await expect(h.run()).resolves.toBe('refused');
    expect(h.state.yiji_coupon_id).toBe('74100');
    expect(String(h.state.yiji_push_error)).toMatch(/General/);
    expect(h.alertNotPrivate).toHaveBeenCalled();
  });

  it('a General coupon is NOT created unowned - watched exactly as before', async () => {
    const h = harness({ coupon_type: 'General' });
    await expect(h.run()).resolves.toBe('awaiting-signup');
    expect(h.postCoupon).not.toHaveBeenCalled();
  });

  it('staging (test-handset redirect) creates nothing for nobody', async () => {
    const h = harness();
    await expect(h.run({ redirectCouponsTo: '0500000000' })).resolves.toBe('awaiting-signup');
    expect(h.postCoupon).not.toHaveBeenCalled();
  });
});

describe('the customer signs up: the EXISTING coupon is assigned', () => {
  const CREATED = {
    yiji_coupon_id: '74100',
    awaiting_signup_at: '2026-11-17T08:00:00Z',
    signup_checked_at: '2026-11-17T08:00:00Z',
    yiji_pushed_at: '2026-11-17T08:00:00Z',
  };

  it('ONE assign call with that coupon id - no creation - and the receipt recorded', async () => {
    const h = harness(CREATED, { customer: 'yiji-user-9' });
    await expect(h.run()).resolves.toBe('delivered');
    expect(h.paths()).toEqual([YIJI_COMPENSATION_COUPON_PATH]);
    expect(h.calls[0]!.body).toMatchObject({
      couponId: 74100,
      userId: 'yiji-user-9',
      couponCode: 'OPS-SGNP1234',
    });
    /* The wallet is read first (a retried assign is never granted twice) and
       the Private check runs before the coupon is given. */
    expect(h.findUserCoupon).toHaveBeenCalledWith('yiji-user-9', 'OPS-SGNP1234');
    expect(h.readCoupon).toHaveBeenCalledWith(74100);
    expect(h.state).toMatchObject({
      status: 'assigned',
      yiji_coupon_user_id: '33001',
      yiji_coupon_id: '74100',
      yiji_push_error: null,
    });
  });

  it('already in the wallet (an earlier assign landed): recorded, nothing sent', async () => {
    const h = harness(CREATED, { customer: 'yiji-user-9', holds: true });
    await expect(h.run()).resolves.toBe('delivered');
    expect(h.postCoupon).not.toHaveBeenCalled();
    expect(h.state).toMatchObject({ status: 'assigned', yiji_coupon_user_id: '33001' });
  });

  it('a refused assign is read back, then recorded - never a creation', async () => {
    const h = harness(CREATED, {
      customer: 'yiji-user-9',
      answer: (p) =>
        p === YIJI_COMPENSATION_COUPON_PATH ? refusedErr('Coupon is inactive') : undefined,
    });
    await expect(h.run()).resolves.toBe('refused');
    expect(h.paths()).toEqual([YIJI_COMPENSATION_COUPON_PATH]);
    expect(String(h.state.yiji_push_error)).toMatch(/inactive/);
    expect(h.state.yiji_coupon_id).toBe('74100');
  });

  it('an assign outage is retried, nothing recorded', async () => {
    const h = harness(CREATED, {
      customer: 'yiji-user-9',
      answer: (p) =>
        p === YIJI_COMPENSATION_COUPON_PATH
          ? Object.assign(new Error('timeout'), { name: 'YijiUnavailableError' })
          : undefined,
    });
    await expect(h.run()).rejects.toThrow(/timeout/);
    expect(h.state.status).toBe('approved');
    expect(h.state.yiji_push_error).toBeNull();
  });

  it('never assigned blind: a failed Private read-back is retried', async () => {
    const h = harness(CREATED, { customer: 'yiji-user-9', readCouponThrows: true });
    await expect(h.run()).rejects.toThrow(/read Yiji coupon 74100 back/);
    expect(h.postCoupon).not.toHaveBeenCalled();
  });

  it('still no account: only the watch is stamped, no Yiji call', async () => {
    const h = harness(CREATED);
    await expect(h.run()).resolves.toBe('awaiting-signup');
    expect(h.postCoupon).not.toHaveBeenCalled();
    expect(h.patches).toHaveLength(1);
    expect(h.patches[0]).not.toHaveProperty('awaiting_signup_at'); // the wait's start is kept
    expect(h.patches[0]).toHaveProperty('signup_checked_at');
  });

  it('the whole life: create (no account) -> sweep -> assign, one coupon, one grant', async () => {
    const h = harness();
    await h.run(); // no account
    await h.run(); // still none
    h.findCustomer.mockResolvedValue('yiji-user-9' as never);
    await expect(h.run()).resolves.toBe('delivered');
    await expect(h.run()).resolves.toBe('already-assigned');
    expect(h.paths()).toEqual([YIJI_UNASSIGNED_COUPON_PATH, YIJI_COMPENSATION_COUPON_PATH]);
    expect(h.calls[1]!.body).toMatchObject({ couponId: 74100, userId: 'yiji-user-9' });
  });
});

describe('rows held BEFORE 17 Nov (watched, no yiji_coupon_id)', () => {
  const LEGACY = {
    awaiting_signup_at: '2026-11-01T08:00:00Z',
    signup_checked_at: '2026-11-16T08:00:00Z',
  };

  it('still no account: created unassigned at the next due look, the wait start kept', async () => {
    const h = harness(LEGACY);
    await expect(h.run()).resolves.toBe('awaiting-signup');
    expect(h.paths()).toEqual([YIJI_UNASSIGNED_COUPON_PATH]);
    expect(h.state).toMatchObject({
      yiji_coupon_id: '74100',
      awaiting_signup_at: '2026-11-01T08:00:00Z',
    });
  });

  it('the number resolves first: created and granted as before (one coupon)', async () => {
    const h = harness(LEGACY, { customer: 'yiji-user-9' });
    await expect(h.run()).resolves.toBe('delivered');
    expect(h.paths()).toEqual([YIJI_UNASSIGNED_COUPON_PATH, YIJI_COMPENSATION_COUPON_PATH]);
    expect(h.state).toMatchObject({ status: 'assigned', yiji_coupon_id: '74100' });
  });

  it('created by a lost earlier attempt ("already exists"): attached BY CODE on signup, read back', async () => {
    let holds = false;
    const h = harness(LEGACY, {
      customer: 'yiji-user-9',
      answer: (p) => {
        if (p === YIJI_UNASSIGNED_COUPON_PATH)
          return refusedErr('Coupon with Code OPS-SGNP1234 already exists!');
        if (p.startsWith(YIJI_ATTACH_BY_CODE_PATH)) {
          holds = true;
          return {};
        }
        return undefined;
      },
    });
    h.findUserCoupon.mockImplementation((async () =>
      holds ? { couponUserId: '33002' } : null) as never);
    await expect(h.run()).resolves.toBe('delivered');
    expect(h.paths()[1]).toBe(`${YIJI_ATTACH_BY_CODE_PATH}/yiji-user-9/OPS-SGNP1234`);
    expect(h.state).toMatchObject({ status: 'assigned', yiji_coupon_user_id: '33002' });
  });
});

describe('what this change must NOT touch', () => {
  it('a withheld coupon with a Yiji id is never assigned, even with a watch stamp', async () => {
    const h = harness(
      {
        delivery_excluded: true,
        yiji_coupon_id: '74100',
        awaiting_signup_at: '2026-11-17T08:00:00Z',
      },
      { customer: 'yiji-user-9' },
    );
    await expect(h.run()).resolves.toBe('already-withheld');
    expect(h.postCoupon).not.toHaveBeenCalled();
  });

  it('a Yiji id WITHOUT a watch (withheld then unticked) is never assigned', async () => {
    const h = harness({ yiji_coupon_id: '74100' }, { customer: 'yiji-user-9' });
    await expect(h.run()).resolves.toBe('already-withheld');
    expect(h.postCoupon).not.toHaveBeenCalled();
  });

  it('a customer WITH an account is created and granted in one push, as before', async () => {
    const h = harness({}, { customer: 'yiji-user-9' });
    await expect(h.run()).resolves.toBe('delivered');
    expect(h.paths()).toEqual([YIJI_UNASSIGNED_COUPON_PATH, YIJI_COMPENSATION_COUPON_PATH]);
    expect(h.state.awaiting_signup_at).toBeNull();
  });
});

describe('removing a coupon created on Yiji but never assigned', () => {
  it('does not fail on the missing grant: removed in the CRM, parked so it is never assigned', async () => {
    const state: Record<string, unknown> = {
      ...ROW,
      yiji_coupon_id: '74100',
      awaiting_signup_at: '2026-11-17T08:00:00Z',
      ticket: { id: 't1' },
    };
    const directus = {
      request: vi.fn(async (r: { op: string; payload?: Record<string, unknown> }) => {
        if (r.op === 'updateItem') {
          Object.assign(state, r.payload);
          return {};
        }
        if (r.op === 'readItems')
          return [{ id: state.id, status: state.status, removal_status: state.removal_status }];
        return { ...state };
      }),
    };
    const out = await processCouponRemoveJob(
      {
        data: { couponApprovalId: 'ca-signup', removedBy: 'sup-1', reason: 'Refunded instead' },
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as never,
      { directus: directus as never, logger, remover: null },
    );
    expect(out).toBe('not-on-yiji');
    expect(state.removal_status).toBe('not_on_yiji');
    expect(String(state.yiji_push_error)).toMatch(/Removed from the ticket/);
    /* And the push - a sweep or a signup - never assigns it afterwards. */
    const postCoupon = vi.fn();
    await expect(
      processCouponPushJob({ data: { couponApprovalId: 'ca-signup' } } as never, {
        directus: directus as never,
        logger,
        postCoupon,
        findCustomer: (async () => 'yiji-user-9') as never,
        yijiTenantId: '1',
      }),
    ).resolves.toBe('removed');
    expect(postCoupon).not.toHaveBeenCalled();
  });
});

describe('the signup sweep and a coupon created while waiting', () => {
  const NOW = new Date('2026-11-17T12:00:00Z');
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('keeps watching it (it is still owed) and says, on expiry, that it exists on Yiji', async () => {
    const patches: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const held = [
      {
        id: 'gone',
        coupon_code: 'OPS-GONE',
        awaiting_signup_at: '2026-10-01T00:00:00Z',
        signup_checked_at: '2026-11-16T00:00:00Z',
        valid_to: '2026-11-10',
        yiji_coupon_id: '74100',
      },
    ];
    const directus = {
      request: vi.fn(
        async (a: {
          op: string;
          id?: string;
          opts?: { filter?: object; fields?: string[] };
          payload?: Record<string, unknown>;
        }) => {
          if (a.payload) {
            patches.push({ id: a.id!, payload: a.payload });
            return {};
          }
          const f = a.opts?.filter ?? {};
          if ('awaiting_signup_at' in f) {
            expect(a.opts?.fields).toContain('yiji_coupon_id');
            return held;
          }
          if ('yiji_coupon_id' in f) return [];
          return [{ id: 'gone' }];
        },
      ),
    };
    const add = vi.fn();
    await runCouponDeliverySweep({
      directus: directus as never,
      logger,
      couponsQueue: { add } as never,
    });
    expect(add).not.toHaveBeenCalled();
    expect(patches[0]!.payload.yiji_push_error).toMatch(
      /created on Yiji \(coupon #74100, Private\) but never assigned/,
    );
  });
});
