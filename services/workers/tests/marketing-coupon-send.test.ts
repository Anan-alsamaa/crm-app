import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  marketingYijiConfigFromEnv,
  runMarketingCouponSend,
} from '../src/processors/marketing-coupon-send.js';

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ kind: 'read', collection, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    kind: 'update',
    collection,
    id,
    payload,
  }),
}));

const logger = pino({ level: 'silent' });
const config = { adminApiUrl: 'https://admin.test', email: 'm@x', password: 'p', tenantId: '1' };
const row = {
  id: 'c1',
  status: 'approved',
  decided_at: '2026-11-02T08:00:00Z',
  code: 'MKT-AB12CD34',
  title: 'World Pasta Day',
  discount_category: 'Amount' as const,
  coupon_value: 20,
  valid_from: '2026-11-10',
  valid_to: '2026-11-20',
  total_uses: 500,
  uses_per_customer: 1,
};

/** A Directus double: `readItems` answers `rows`, `updateItem` calls are kept. */
function directusWith(
  rows: unknown[],
  recipients: Array<{ id: string; phone: string; status: string }> = [],
) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const request = vi.fn(
    async (q: {
      kind: string;
      collection?: string;
      id?: string;
      payload?: unknown;
      opts?: { filter?: unknown; aggregate?: unknown };
    }) => {
      if (q.kind === 'update') {
        updates.push({ id: q.id!, patch: q.payload as Record<string, unknown> });
        return {};
      }
      if (q.collection === 'marketing_coupon_recipients') {
        const st = JSON.stringify(q.opts?.filter ?? {});
        const want = /"status":\{"_eq":"(\w+)"\}/.exec(st)?.[1];
        const list = recipients.filter((r) => !want || r.status === want);
        return q.opts?.aggregate ? [{ count: { id: list.length } }] : list;
      }
      return rows;
    },
  );
  return { directus: { request } as never, updates };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the marketing coupon sender', () => {
  it('is off without the marketing Yiji account', () => {
    expect(marketingYijiConfigFromEnv({ YIJI_ADMIN_API_URL: 'https://a' })).toBeNull();
  });

  it('does nothing at all when off', async () => {
    const { directus } = directusWith([row]);
    const fetchImpl = vi.fn();
    const r = await runMarketingCouponSend({ directus, config: null, logger, fetchImpl });
    expect(r).toEqual({ created: 0, failed: 0, waiting: 0, given: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('creates an approved coupon once and records Yiji’s id', async () => {
    const { directus, updates } = directusWith([row]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { token: 't' }))
      .mockResolvedValueOnce(json(200, { result: 1, exceptionMessage: 'couponId 91234' }));
    const r = await runMarketingCouponSend({ directus, config, logger, fetchImpl, pauseMs: 0 });
    expect(r.created).toBe(1);
    expect(fetchImpl.mock.calls[1]![0]).toBe('https://admin.test/api/Coupon/AddCoupon');
    const sent = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(sent.code).toBe('MKT-AB12CD34');
    expect(sent).not.toHaveProperty('restaurantId');
    expect(updates[0]!.patch).toMatchObject({ status: 'created', yiji_coupon_id: '91234' });
  });

  it('records a refusal and does not retry it', async () => {
    const { directus, updates } = directusWith([row]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { token: 't' }))
      .mockResolvedValueOnce(
        json(200, { result: 2, exceptionMessage: 'Coupon with Code already exists!' }),
      );
    const r = await runMarketingCouponSend({ directus, config, logger, fetchImpl, pauseMs: 0 });
    expect(r.failed).toBe(1);
    expect(updates[0]!.patch.status).toBe('failed');
    expect(String(updates[0]!.patch.send_error)).toContain('already exists');
  });

  it('leaves it approved when Yiji does not answer', async () => {
    const { directus, updates } = directusWith([row]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { token: 't' }))
      .mockResolvedValueOnce(json(503, {}));
    const r = await runMarketingCouponSend({ directus, config, logger, fetchImpl, pauseMs: 0 });
    expect(r.waiting).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it('a refused login sends nothing', async () => {
    const { directus, updates } = directusWith([row]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(401, {}));
    const r = await runMarketingCouponSend({ directus, config, logger, fetchImpl, pauseMs: 0 });
    expect(r.waiting).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(0);
  });
});

describe('a bulk (list) coupon', () => {
  const listRow = { ...row, id: 'b1', audience: 'list' as const };

  it('is created Private with as many uses as its list, then moves to sending', async () => {
    const recips = [
      { id: 'r1', phone: '0501234567', status: 'queued' },
      { id: 'r2', phone: '0551112222', status: 'queued' },
    ];
    const { directus, updates } = directusWith([listRow], recips);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { token: 't' }))
      .mockResolvedValueOnce(json(200, { result: 1, exceptionMessage: 'couponId 77' }));
    await runMarketingCouponSend({ directus, config, logger, fetchImpl, pauseMs: 0 });
    const sent = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(sent.type).toBe(1);
    expect(sent.reachLimit).toBe(2);
    expect(updates[0]!.patch).toMatchObject({ status: 'sending', recipient_count: 2 });
  });

  it('gives it to customers with exactly one Yiji account, and records the rest', async () => {
    const sending = { ...listRow, status: 'sending', yiji_coupon_id: '77' };
    const recips = [
      { id: 'r1', phone: '0501234567', status: 'queued' },
      { id: 'r2', phone: '0551112222', status: 'queued' },
    ];
    const { directus, updates } = directusWith([sending], recips);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { token: 't' }))
      .mockResolvedValueOnce(json(200, [{ id: 'u-1', phoneNumber: '+966501234567' }]))
      .mockResolvedValueOnce(json(200, { result: 1 }))
      .mockResolvedValueOnce(json(200, []));
    const r = await runMarketingCouponSend({ directus, config, logger, fetchImpl, pauseMs: 0 });
    expect(r.given).toBe(1);
    expect(String(fetchImpl.mock.calls[2]![0])).toContain(
      '/AddCouponToUserByCode/u-1/MKT-AB12CD34',
    );
    expect(updates.find((u) => u.id === 'r1')!.patch.status).toBe('sent');
    expect(updates.find((u) => u.id === 'r2')!.patch.status).toBe('no_account');
  });
});
