import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnknownVendorError, YijiShedError, YijiUnavailableError } from '@yiji/shared-types';
import {
  COUPON_CUSTOMER_CHECK_BATCH,
  COUPON_CUSTOMER_CHECK_JOB,
  runCouponCustomerCheck,
  scheduleCouponCustomerCheck,
} from '../src/processors/coupon-customer-check.js';

/**
 * "HAS THIS CUSTOMER A YIJI ACCOUNT?" - ASKED ONCE BY THE WORKERS, STORED
 * (incident 2026-10-26: the approval page asked Yiji per card and flooded it).
 *
 * Pins: at most a batch of lookups per run; rows without a phone are skipped;
 * the answer is written as found / not-found + checked_at; a guard refusal or
 * an outage leaves the row unchecked and STOPS the run; the row's vendor picks
 * the connector; missing fields make the job inert (no Yiji call).
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({ collection, id, payload }),
}));

const NOW = new Date('2026-10-26T18:00:00Z');
const logger = { info: vi.fn(), warn: vi.fn() };

type Row = {
  id: string;
  customer_phone?: string | null;
  title?: string | null;
  contact?: { phone?: string | null } | null;
  vendor?: string | null;
};

function harness(
  fresh: Row[],
  stale: Row[] = [],
  opts: { readFails?: boolean; writeFails?: boolean } = {},
) {
  const patches: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const filters: unknown[] = [];
  const directus = {
    request: vi.fn(
      async (arg: {
        id?: string;
        payload?: Record<string, unknown>;
        opts?: { filter?: { _and?: Array<Record<string, unknown>> } };
      }) => {
        if (arg.payload) {
          if (opts.writeFails) throw new Error('403 forbidden');
          patches.push({ id: arg.id!, payload: arg.payload });
          return {};
        }
        if (opts.readFails) throw new Error('403 forbidden field yiji_customer_checked_at');
        filters.push(arg.opts?.filter);
        const last = arg.opts?.filter?._and?.at(-1) as
          | { yiji_customer_checked_at?: Record<string, unknown> }
          | undefined;
        return last?.yiji_customer_checked_at && '_null' in last.yiji_customer_checked_at
          ? fresh
          : stale;
      },
    ),
  };
  return { directus, patches, filters };
}

function connectorsWith(
  find: ((phone: string) => Promise<string | null>) | null,
  extra: { byVendor?: Record<string, ((p: string) => Promise<string | null>) | null> } = {},
) {
  const connectorFor = vi.fn(async (vendor: string) => {
    if (vendor === 'gone') throw new UnknownVendorError(vendor, 'unknown');
    const f = extra.byVendor && vendor in extra.byVendor ? extra.byVendor[vendor]! : find;
    return { findCustomerIdByPhone: f } as never;
  });
  return {
    connectorFor,
    defaultVendorForLegacyRecords: vi.fn(async () => 'legacy'),
  };
}

const run = (
  h: ReturnType<typeof harness>,
  connectors: ReturnType<typeof connectorsWith>,
  batch?: number,
) =>
  runCouponCustomerCheck({
    directus: h.directus as never,
    connectors,
    logger,
    now: () => NOW,
    ...(batch !== undefined ? { batch } : {}),
  });

beforeEach(() => {
  logger.info.mockReset();
  logger.warn.mockReset();
});

describe('runCouponCustomerCheck', () => {
  it('only asks about PENDING, not-withheld, unchecked-or-stale rows', async () => {
    const h = harness([]);
    await run(h, connectorsWith(vi.fn()));
    const [fresh, stale] = h.filters as Array<{ _and: unknown[] }>;
    expect(JSON.stringify(fresh)).toContain('"status":{"_eq":"pending"}');
    expect(JSON.stringify(fresh)).toContain('delivery_excluded');
    expect(JSON.stringify(fresh)).toContain('"yiji_customer_checked_at":{"_null":true}');
    /* Stale = checked more than a day ago. */
    expect(JSON.stringify(stale)).toContain(
      `"yiji_customer_checked_at":{"_lt":"${new Date(NOW.getTime() - 86_400_000).toISOString()}"}`,
    );
  });

  it('looks each phone up once and stores found / not-found with checked_at', async () => {
    const find = vi.fn(async (p: string) => (p === '0501111111' ? '42' : null));
    const h = harness([
      { id: 'a', customer_phone: '0501111111' },
      { id: 'b', contact: { phone: '+966502222222' } },
      { id: 'c', title: '0503333333' },
    ]);
    const r = await run(h, connectorsWith(find));
    expect(find.mock.calls.map(([p]) => p)).toEqual(['0501111111', '+966502222222', '0503333333']);
    expect(h.patches).toEqual([
      {
        id: 'a',
        payload: { yiji_customer_found: true, yiji_customer_checked_at: NOW.toISOString() },
      },
      {
        id: 'b',
        payload: { yiji_customer_found: false, yiji_customer_checked_at: NOW.toISOString() },
      },
      {
        id: 'c',
        payload: { yiji_customer_found: false, yiji_customer_checked_at: NOW.toISOString() },
      },
    ]);
    expect(r).toEqual({ looked: 3, found: 1, notFound: 2 });
  });

  it('never makes more than a batch of lookups in one run (default 10)', async () => {
    const find = vi.fn(async () => null);
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      customer_phone: `05000000${String(i).padStart(2, '0')}`,
    }));
    const h = harness(rows.slice(0, 30), rows.slice(30));
    const r = await run(h, connectorsWith(find));
    expect(COUPON_CUSTOMER_CHECK_BATCH).toBe(10);
    expect(find).toHaveBeenCalledTimes(10);
    expect(h.patches).toHaveLength(10);
    expect(r.looked).toBe(10);
    /* Never-checked rows go first. */
    expect(h.patches.map((p) => p.id)).toEqual(rows.slice(0, 10).map((r) => r.id));
  });

  it('skips rows with no deliverable phone (and they do not use up the batch)', async () => {
    const find = vi.fn(async () => '7');
    const h = harness([
      { id: 'none', customer_phone: null, contact: null, title: 'Sorry for the delay' },
      { id: 'short', customer_phone: '1234' },
      { id: 'ok', customer_phone: '0504444444' },
    ]);
    await run(h, connectorsWith(find), 1);
    expect(find).toHaveBeenCalledTimes(1);
    expect(h.patches.map((p) => p.id)).toEqual(['ok']);
  });

  it('a guard refusal leaves the row UNCHECKED and stops the run', async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce('1')
      .mockRejectedValueOnce(new YijiShedError('customer.lookup', 'normal', 'budget', 30_000))
      .mockResolvedValue('1');
    const h = harness([
      { id: 'a', customer_phone: '0501111111' },
      { id: 'b', customer_phone: '0502222222' },
      { id: 'c', customer_phone: '0503333333' },
    ]);
    const r = await run(h, connectorsWith(find));
    expect(find).toHaveBeenCalledTimes(2);
    expect(h.patches.map((p) => p.id)).toEqual(['a']);
    expect(r.stopped).toBe('yiji-unavailable');
  });

  it('a Yiji outage (timeout) is not an answer either: nothing written, run stops', async () => {
    const find = vi.fn().mockRejectedValue(new YijiUnavailableError('timed out after 6000ms'));
    const h = harness([
      { id: 'a', customer_phone: '0501111111' },
      { id: 'b', customer_phone: '0502222222' },
    ]);
    const r = await run(h, connectorsWith(find));
    expect(find).toHaveBeenCalledTimes(1);
    expect(h.patches).toEqual([]);
    expect(r.stopped).toBe('yiji-unavailable');
  });

  it('any other lookup failure leaves that row unchecked and moves on', async () => {
    const find = vi.fn().mockRejectedValueOnce(new Error('bad phone')).mockResolvedValue('9');
    const h = harness([
      { id: 'a', customer_phone: '0501111111' },
      { id: 'b', customer_phone: '0502222222' },
    ]);
    await run(h, connectorsWith(find));
    expect(h.patches.map((p) => p.id)).toEqual(['b']);
  });

  it('uses the ROW’s vendor connector; a vendor-less row uses the legacy vendor', async () => {
    const yijiFind = vi.fn(async () => '1');
    const otherFind = vi.fn(async () => null);
    const c = connectorsWith(yijiFind, { byVendor: { 'v-2': otherFind } });
    const h = harness([
      { id: 'a', customer_phone: '0501111111', vendor: 'v-2' },
      { id: 'b', customer_phone: '0502222222', vendor: null },
      { id: 'c', customer_phone: '0503333333', vendor: 'gone' },
    ]);
    await run(h, c);
    expect(otherFind).toHaveBeenCalledWith('0501111111');
    expect(yijiFind).toHaveBeenCalledWith('0502222222');
    expect(c.connectorFor).toHaveBeenCalledWith('legacy');
    /* An unknown vendor gets no lookup and stays unchecked. */
    expect(h.patches.map((p) => [p.id, p.payload.yiji_customer_found])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('a vendor without a phone lookup configured records nothing (not checked)', async () => {
    const h = harness([{ id: 'a', customer_phone: '0501111111' }]);
    const r = await run(h, connectorsWith(null));
    expect(h.patches).toEqual([]);
    expect(r.looked).toBe(0);
  });

  it('fields not applied: the read fails and NO Yiji call is made', async () => {
    const find = vi.fn(async () => '1');
    const h = harness([{ id: 'a', customer_phone: '0501111111' }], [], { readFails: true });
    const r = await run(h, connectorsWith(find));
    expect(find).not.toHaveBeenCalled();
    expect(r.stopped).toBe('read-failed');
  });

  it('a write that fails stops the run (no further Yiji calls wasted)', async () => {
    const find = vi.fn(async () => '1');
    const h = harness(
      [
        { id: 'a', customer_phone: '0501111111' },
        { id: 'b', customer_phone: '0502222222' },
      ],
      [],
      { writeFails: true },
    );
    const r = await run(h, connectorsWith(find));
    expect(find).toHaveBeenCalledTimes(1);
    expect(r.stopped).toBe('write-failed');
  });

  it('a row in both reads is looked up once', async () => {
    const find = vi.fn(async () => '1');
    const row = { id: 'a', customer_phone: '0501111111' };
    const h = harness([row], [row]);
    await run(h, connectorsWith(find));
    expect(find).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleCouponCustomerCheck', () => {
  it('one scheduler, one attempt; 0 removes it', async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn() };
    await scheduleCouponCustomerCheck(queue as never, 120_000);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'coupon-customer-check',
      { every: 120_000 },
      expect.objectContaining({
        name: COUPON_CUSTOMER_CHECK_JOB,
        opts: expect.objectContaining({ attempts: 1 }),
      }),
    );
    await scheduleCouponCustomerCheck(queue as never, 0);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('coupon-customer-check');
  });
});
