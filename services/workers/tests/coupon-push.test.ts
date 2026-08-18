import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  processCouponPushJob,
  yijiCouponPayload,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';

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
  title: '+966500000000',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'Casa Pasta',
  restaurant_id: 'store-4',
  reason: 'Order arrived cold.',
  contact: { name: 'Saad Al-Harbi', phone: '+966500000000', external_customer_id: 'yiji-77' },
};

function deps(
  overrides: Partial<Parameters<typeof processCouponPushJob>[1]> = {},
  row: CouponApprovalRow = ROW,
) {
  const directus = { request: vi.fn(async () => row) };
  return {
    directus,
    deps: {
      directus: directus as never,
      logger,
      yijiCouponUrl: 'https://yiji.example/coupons',
      yijiApiKey: 'k',
      ...overrides,
    },
  };
}

const job = (id = 'ca-1') =>
  ({ data: { couponApprovalId: id } }) as Job<{ couponApprovalId: string }>;

describe('yijiCouponPayload', () => {
  it('sends numbers, not the strings Postgres returns for numeric', () => {
    const p = yijiCouponPayload(ROW);
    expect(p.amount).toBe(25);
    expect(p.max_discount).toBe(50);
    expect(p.usage_limit).toBe(1);
  });

  it('leaves the other money field null so a coupon can never carry both', () => {
    expect(yijiCouponPayload(ROW).percentage).toBeNull();
    const pct = yijiCouponPayload({ ...ROW, coupon_value: null, coupon_percent: '10.00000' });
    expect(pct.percentage).toBe(10);
    expect(pct.amount).toBeNull();
  });

  it('covers the last day in full', () => {
    // Whole days: 18 Aug to 18 Sep must run until the START of 19 Sep, or the
    // customer loses the final day of a coupon they were promised.
    const p = yijiCouponPayload(ROW);
    expect(p.valid_from).toBe('2026-08-18T00:00:00.000Z');
    expect(p.valid_to).toBe('2026-09-19T00:00:00.000Z');
  });

  it('carries the customer Yiji has to match against', () => {
    expect(yijiCouponPayload(ROW).customer).toEqual({
      phone: '+966500000000',
      name: 'Saad Al-Harbi',
      external_customer_id: 'yiji-77',
    });
  });
});

describe('processCouponPushJob', () => {
  it('posts the coupon and marks it assigned', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const { deps: d } = deps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await processCouponPushJob(job(), d)).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The same key on every retry, so a timeout that actually succeeded cannot
    // become a second coupon in the customer's account.
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('OPS-ABC23456');
  });

  it('does not claim delivery when no endpoint is configured', async () => {
    // Marking it assigned would tell every report Yiji holds a coupon it has
    // never heard of, and that difference is the only record of whether the
    // customer can redeem anything.
    const fetchImpl = vi.fn();
    const { deps: d } = deps({
      yijiCouponUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await processCouponPushJob(job(), d)).toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a Yiji error so BullMQ retries rather than losing the coupon', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream boom', { status: 502 }));
    const { deps: d } = deps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(processCouponPushJob(job(), d)).rejects.toThrow(/502/);
  });

  it('refuses to push a coupon that is not approved', async () => {
    // The job carries only an id and the row is re-read here, so a rejection
    // between queueing and delivery has to be honoured — otherwise a coupon a
    // supervisor turned down could still reach the customer.
    const fetchImpl = vi.fn();
    const { deps: d } = deps(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      {
        ...ROW,
        status: 'rejected',
      },
    );
    expect(await processCouponPushJob(job(), d)).toBe('not-approved');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pushes an amended approval, which is still an approval', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const { deps: d } = deps(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      {
        ...ROW,
        status: 'edited',
      },
    );
    expect(await processCouponPushJob(job(), d)).toBe('delivered');
  });

  it('does not push twice when the job is replayed', async () => {
    const fetchImpl = vi.fn();
    const { deps: d } = deps(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      {
        ...ROW,
        status: 'assigned',
      },
    );
    expect(await processCouponPushJob(job(), d)).toBe('already-assigned');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
