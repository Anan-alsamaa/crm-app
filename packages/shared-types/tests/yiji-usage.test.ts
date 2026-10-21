import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createYijiUsageRecorder,
  fetchWithYijiUsage,
  isYijiAuthRefusal,
  redactUsageText,
  reportYijiUsage,
  yijiBackupTokenFromEnv,
  yijiOperationFor,
  yijiUsageOutcome,
  yijiUsageRow,
  type YijiUsageEvent,
  type YijiUsageRow,
} from '../src/index.js';

/**
 * `yiji_api_usage` (owner, 2026-10-21): every Yiji call is recorded with the
 * account that made it - and recording can never break the call it describes.
 */

const ev = (over: Partial<YijiUsageEvent> = {}): YijiUsageEvent => ({
  operation: 'order.lookup',
  account: 'crm',
  outcome: 'ok',
  httpStatus: 200,
  durationMs: 12,
  ...over,
});

describe('yijiOperationFor', () => {
  it.each([
    ['https://admin.x/api/Account/login', 'login'],
    ['https://admin.x/api/CouponUser/RemoveUserCoupon/27507', 'coupon.remove'],
    ['https://admin.x/api/CouponUser/GetActiveCouponByUser/u?PageNumber=1', 'coupon.wallet'],
    ['https://admin.x/api/CouponUser/GetCouponByUser/u', 'coupon.wallet'],
    ['/api/CouponUserOrder/CreateCouponUserFromOrder', 'coupon.push'],
    ['/api/CouponUser/AddUserCoupon', 'coupon.push'],
    ['/api/CouponUser/AddCouponToUserByCode/u/OPS-1', 'coupon.push'],
    ['/api/Coupon/AddCoupon', 'coupon.create'],
    ['/api/User/GetfilteredCustomers?PhoneNumber=501234567', 'customer.lookup'],
    ['/api/User/GetUserById/abc', 'user.lookup'],
    ['https://notify.x/api/NotificationData/SendCrmNotification', 'push.notify'],
    ['/api/Order/GetFilteredOrders?DeliveryTypeIds=1', 'order.late_poll'],
    ['/api/OrderStatusHistories/GetOrderStatusHistoriesByOrderId/5', 'order.history'],
    ['/api/Order/GetOrderCart/5', 'order.cart'],
    ['/api/Order/GetOrderByUser/u', 'order.by_user'],
    ['/api/Order/GetOrderAsync/5', 'order.lookup'],
    ['https://elsewhere.x/whatever', 'other'],
  ])('%s -> %s', (url, op) => {
    expect(yijiOperationFor(url)).toBe(op);
  });
});

describe('outcome + auth refusal', () => {
  it('2xx and 404 are answers, other 4xx refusals, 5xx / no answer errors', () => {
    expect(yijiUsageOutcome(200)).toBe('ok');
    expect(yijiUsageOutcome(404)).toBe('ok');
    expect(yijiUsageOutcome(400)).toBe('refused');
    expect(yijiUsageOutcome(403)).toBe('refused');
    expect(yijiUsageOutcome(502)).toBe('error');
    expect(yijiUsageOutcome(null)).toBe('error');
  });
  it('only 401 and 403 are credential refusals', () => {
    expect(isYijiAuthRefusal(401)).toBe(true);
    expect(isYijiAuthRefusal(403)).toBe(true);
    expect(isYijiAuthRefusal(400)).toBe(false);
    expect(isYijiAuthRefusal(null)).toBe(false);
  });
});

describe('redactUsageText', () => {
  it('drops tokens, query strings, e-mails and phone numbers; keeps ids', () => {
    const out = redactUsageText(
      'Bearer eyJabc.def-ghi for https://a.x/api/User/GetfilteredCustomers?PhoneNumber=501234567 ' +
        'by crm@anan.sa on +966501234567, grant 27507',
    )!;
    expect(out).not.toContain('eyJabc');
    expect(out).not.toContain('501234567');
    expect(out).not.toContain('crm@anan.sa');
    expect(out).toContain('27507');
  });
  it('is short, and null stays null', () => {
    expect(redactUsageText('x'.repeat(500))!.length).toBeLessThanOrEqual(200);
    expect(redactUsageText(null)).toBeNull();
  });
});

describe('yijiBackupTokenFromEnv', () => {
  it('reads YIJI_BACKUP_TOKEN, then the old YIJI_COUPON_REMOVE_TOKEN name', () => {
    expect(yijiBackupTokenFromEnv({ YIJI_BACKUP_TOKEN: 'Bearer A' })).toBe('A');
    expect(yijiBackupTokenFromEnv({ YIJI_COUPON_REMOVE_TOKEN: 'B' })).toBe('B');
    expect(yijiBackupTokenFromEnv({ YIJI_BACKUP_TOKEN: 'A', YIJI_COUPON_REMOVE_TOKEN: 'B' })).toBe(
      'A',
    );
    expect(yijiBackupTokenFromEnv({ YIJI_BACKUP_TOKEN: '  ' })).toBeUndefined();
  });
});

describe('yijiUsageRow', () => {
  it('maps an event onto the collection, redacting the free text', () => {
    expect(
      yijiUsageRow(
        'workers',
        ev({
          account: 'backup',
          outcome: 'refused',
          httpStatus: 403,
          fallbackReason: 'crm account refused (403)',
          error: 'HTTP 403',
          vendor: '1',
        }),
      ),
    ).toEqual({
      service: 'workers',
      operation: 'order.lookup',
      account: 'backup',
      outcome: 'refused',
      http_status: 403,
      duration_ms: 12,
      fallback_reason: 'crm account refused (403)',
      error: 'HTTP 403',
      vendor: '1',
    });
  });
});

describe('reportYijiUsage', () => {
  it('a sink that throws never reaches the caller', () => {
    expect(() =>
      reportYijiUsage(() => {
        throw new Error('boom');
      }, ev()),
    ).not.toThrow();
    expect(() => reportYijiUsage(undefined, ev())).not.toThrow();
  });
});

describe('createYijiUsageRecorder', () => {
  afterEach(() => vi.useRealTimers());

  it('buffers, and writes on the timer in one batch', async () => {
    vi.useFakeTimers();
    const writes: YijiUsageRow[][] = [];
    const rec = createYijiUsageRecorder({
      service: 'ai-gateway',
      write: async (rows) => {
        writes.push(rows);
      },
      flushMs: 1000,
    });
    rec.record(ev());
    rec.record(ev({ operation: 'login' }));
    expect(writes).toEqual([]);
    expect(rec.pending()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.map((r) => r.operation)).toEqual(['order.lookup', 'login']);
    expect(rec.pending()).toBe(0);
  });

  it('writes at once when a batch fills', async () => {
    const writes: number[] = [];
    const rec = createYijiUsageRecorder({
      service: 'workers',
      write: async (rows) => {
        writes.push(rows.length);
      },
      batchSize: 2,
      flushMs: 60_000,
    });
    rec.record(ev());
    rec.record(ev());
    await rec.flush();
    expect(writes).toEqual([2]);
    await rec.stop();
  });

  it('a failed write is dropped and reported, never thrown', async () => {
    const onError = vi.fn();
    const rec = createYijiUsageRecorder({
      service: 'socket-gateway',
      write: async () => {
        throw new Error('directus down');
      },
      onError,
    });
    rec.record(ev());
    await expect(rec.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 1);
    expect(rec.pending()).toBe(0);
    await rec.stop();
  });

  it('is bounded: beyond maxBuffer the oldest rows go', async () => {
    const onError = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rec = createYijiUsageRecorder({
      service: 'workers',
      write: () => gate,
      batchSize: 2,
      maxBuffer: 3,
      onError,
    });
    for (let i = 0; i < 2; i++) rec.record(ev()); // fills a batch -> in flight
    for (let i = 0; i < 5; i++) rec.record(ev({ operation: `op${i}` }));
    expect(rec.pending()).toBeLessThanOrEqual(3);
    expect(onError).toHaveBeenCalled();
    release();
    await rec.stop();
  });
});

describe('fetchWithYijiUsage', () => {
  it('reports the call and returns the response untouched', async () => {
    const sink = vi.fn();
    const f = fetchWithYijiUsage(
      sink,
      'crm',
      (async () => new Response('{}', { status: 502 })) as unknown as typeof fetch,
    );
    const res = await f('https://n.x/api/NotificationData/SendNotification', { method: 'POST' });
    expect(res.status).toBe(502);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'push.notify', outcome: 'error', httpStatus: 502 }),
    );
  });
  it('a network failure is reported and re-thrown', async () => {
    const sink = vi.fn();
    const f = fetchWithYijiUsage(sink, 'crm', (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch);
    await expect(f('https://n.x/api/Order/GetOrderAsync/1')).rejects.toThrow('ECONNRESET');
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'order.lookup', outcome: 'error', httpStatus: null }),
    );
  });
});
