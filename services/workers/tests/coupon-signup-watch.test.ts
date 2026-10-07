import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { runCouponDeliverySweep } from '../src/processors/coupon-push.js';

/**
 * COUPONS HELD UNTIL THE CUSTOMER JOINS YIJI (owner, 2026-10-07, EMA-49).
 *
 * The delivery sweep runs every minute and selects every coupon still owed —
 * which includes the held ones. Without the schedule each held number would be
 * looked up on Yiji 1,440 times a day; the owner asked for checks that do not
 * load the system. These pin that a held coupon is only enqueued when due, and
 * that one which outlived its coupon is recorded and dropped for good.
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
const NOW = new Date('2026-10-07T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function harness(owed: Array<{ id: string }>, held: Array<Record<string, unknown>>) {
  const patches: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const directus = {
    request: vi.fn(
      async (arg: {
        opts?: { filter?: Record<string, unknown> };
        id?: string;
        payload?: Record<string, unknown>;
      }) => {
        if (arg.payload) {
          patches.push({ id: arg.id!, payload: arg.payload });
          return {};
        }
        const filter = arg.opts?.filter ?? {};
        if ('awaiting_signup_at' in filter) return held;
        if ('yiji_coupon_id' in filter) return [];
        return owed;
      },
    ),
  };
  const added: string[] = [];
  const couponsQueue = {
    add: vi.fn(async (_n: string, data: { couponApprovalId: string }) => {
      added.push(data.couponApprovalId);
    }),
  };
  return { directus, couponsQueue, added, patches };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
afterEach(() => vi.useRealTimers());

describe('the delivery sweep and coupons held for signup', () => {
  it('looks a held number up again only when its schedule says so', async () => {
    const h = harness(
      [{ id: 'fresh-due' }, { id: 'fresh-wait' }, { id: 'old-wait' }, { id: 'normal' }],
      [
        // First day: every 10 minutes.
        {
          id: 'fresh-due',
          awaiting_signup_at: minutesAgo(60),
          signup_checked_at: minutesAgo(11),
          valid_to: null,
        },
        {
          id: 'fresh-wait',
          awaiting_signup_at: minutesAgo(60),
          signup_checked_at: minutesAgo(4),
          valid_to: null,
        },
        // Three days in: hourly, so 30 minutes is too soon.
        {
          id: 'old-wait',
          awaiting_signup_at: minutesAgo(3 * 24 * 60),
          signup_checked_at: minutesAgo(30),
          valid_to: null,
        },
      ],
    );
    await runCouponDeliverySweep({
      directus: h.directus as never,
      logger,
      couponsQueue: h.couponsQueue as never,
    });
    expect(h.added.sort()).toEqual(['fresh-due', 'normal']);
  });

  it('stops for good once the coupon has expired, saying why', async () => {
    const h = harness(
      [{ id: 'gone' }],
      [
        {
          id: 'gone',
          awaiting_signup_at: minutesAgo(9000),
          signup_checked_at: minutesAgo(2000),
          valid_to: '2026-10-06',
        },
      ],
    );
    await runCouponDeliverySweep({
      directus: h.directus as never,
      logger,
      couponsQueue: h.couponsQueue as never,
    });
    expect(h.added).toEqual([]);
    expect(h.patches[0]).toMatchObject({
      id: 'gone',
      payload: { yiji_push_error: expect.stringContaining('did not join Yiji') },
    });
  });

  it('still delivers every other coupon when the held read fails', async () => {
    const h = harness([{ id: 'a' }, { id: 'b' }], []);
    const base = h.directus.request.getMockImplementation()!;
    h.directus.request.mockImplementation(async (arg) => {
      if (arg.opts?.filter && 'awaiting_signup_at' in arg.opts.filter) throw new Error('403');
      return base(arg);
    });
    const queued = await runCouponDeliverySweep({
      directus: h.directus as never,
      logger,
      couponsQueue: h.couponsQueue as never,
    });
    expect(queued).toBe(2);
  });
});
