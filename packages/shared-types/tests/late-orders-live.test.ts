import { describe, expect, it } from 'vitest';
import {
  filterLateRows,
  isServableLateOrdersSnapshot,
  lateOrdersRowsHash,
  lateOrdersVendorKey,
  liveLateOrdersQuery,
  type LateOrderRow,
  type LateOrdersSnapshot,
} from '../src/index.js';

/** The contract the workers' poller (writer) and the gateway (reader) share. */
const row = (orderId: string, over: Partial<LateOrderRow> = {}): LateOrderRow => ({
  orderId,
  status: 'in_delivery',
  minutesElapsed: 61,
  placedAt: '2026-10-12T12:00:00',
  ...over,
});

describe('lateOrdersRowsHash', () => {
  it('ignores the minutes ticking and the row order', () => {
    const a = [row('1'), row('2')];
    const b = [row('2', { minutesElapsed: 99 }), row('1', { minutesElapsed: 62 })];
    expect(lateOrdersRowsHash(a)).toBe(lateOrdersRowsHash(b));
  });

  it('changes when an order arrives, leaves, or changes status', () => {
    const base = lateOrdersRowsHash([row('1')]);
    expect(lateOrdersRowsHash([row('1'), row('2')])).not.toBe(base);
    expect(lateOrdersRowsHash([])).not.toBe(base);
    expect(lateOrdersRowsHash([row('1', { status: 'closed', live: false })])).not.toBe(base);
  });
});

describe('isServableLateOrdersSnapshot', () => {
  const now = Date.parse('2026-10-12T10:00:00Z');
  const snap = (over: Partial<LateOrdersSnapshot> = {}): LateOrdersSnapshot => ({
    rows: [],
    thresholdMinutes: 60,
    builtAt: new Date(now - 60_000).toISOString(),
    day: '2026-10-12',
    hash: '',
    vendorKey: 'yiji:1',
    ...over,
  });
  const want = { day: '2026-10-12', thresholdMinutes: 60, nowMs: now };

  it('serves a fresh snapshot for the same day and threshold', () => {
    expect(isServableLateOrdersSnapshot(snap(), want)).toBe(true);
  });

  it('refuses a missing, stale, other-day, other-threshold or future snapshot', () => {
    expect(isServableLateOrdersSnapshot(null, want)).toBe(false);
    expect(
      isServableLateOrdersSnapshot(snap({ builtAt: new Date(now - 181_000).toISOString() }), want),
    ).toBe(false);
    expect(isServableLateOrdersSnapshot(snap({ day: '2026-10-11' }), want)).toBe(false);
    expect(isServableLateOrdersSnapshot(snap({ thresholdMinutes: 45 }), want)).toBe(false);
    expect(
      isServableLateOrdersSnapshot(snap({ builtAt: new Date(now + 60_000).toISOString() }), want),
    ).toBe(false);
    expect(isServableLateOrdersSnapshot(snap({ builtAt: 'nonsense' }), want)).toBe(false);
  });
});

describe('the shared query, filter and key', () => {
  it("asks for the portal's Today window: one business day, finished orders included", () => {
    expect(liveLateOrdersQuery('2026-10-12')).toEqual({
      from: '2026-10-12',
      to: '2026-10-12',
      includeCompleted: true,
      maxPages: 200,
    });
  });

  it('drops an order that never reached the threshold', () => {
    expect(
      filterLateRows([row('1', { minutesElapsed: 9 }), row('2')], 60).map((r) => r.orderId),
    ).toEqual(['2']);
  });

  it('keys a vendor by its platform and platform id, however the request named it', () => {
    expect(
      lateOrdersVendorKey({ platform: 'yiji', vendor: { platformVendorId: '1' } } as never),
    ).toBe('yiji:1');
  });
});
