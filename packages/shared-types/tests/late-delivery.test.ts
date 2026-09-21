import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LATE_DELIVERY_MINUTES,
  isLiveOrderStatus,
  LATE_ORDER_COMPLAINT_TYPE,
  lateDeliveryMinutes,
  LateOrderDecision,
  minutesSince,
  parseYijiTimestamp,
} from '../src/late-delivery.js';
import { couponOrderId } from '../src/coupon-approvals.js';

describe('lateDeliveryMinutes', () => {
  it('takes a sensible configured value', () => {
    expect(lateDeliveryMinutes('45')).toBe(45);
    expect(lateDeliveryMinutes(90)).toBe(90);
    expect(lateDeliveryMinutes(' 30 ')).toBe(30);
  });

  /*
   * The setting is edited by operations in a text box, so every way it can be
   * wrong resolves to the documented rule rather than to a queue that silently
   * matches everything or nothing.
   */
  it.each([
    ['unset', null],
    ['blank', ''],
    ['whitespace', '   '],
    ['a typo', 'sixty'],
    ['zero', '0'],
    ['negative', '-30'],
    ['absurd', '6000'],
  ])('falls back to the default for %s', (_label, value) => {
    expect(lateDeliveryMinutes(value)).toBe(DEFAULT_LATE_DELIVERY_MINUTES);
  });

  it('the documented default is 60 — the owner’s rule for every brand', () => {
    expect(DEFAULT_LATE_DELIVERY_MINUTES).toBe(60);
  });

  it('floors a fractional value rather than carrying seconds', () => {
    expect(lateDeliveryMinutes('60.9')).toBe(60);
  });
});

describe('isLiveOrderStatus', () => {
  /*
   * The reason this exists: `GetFilteredOrders` returns FINISHED and CANCELLED
   * orders whose span passed the threshold — a force_cancel at 3.1 minutes came
   * back under a 60-minute filter (measured 2026-09-21). Without this filter a
   * cancelled order would be offered to an agent to compensate.
   */
  it('accepts an order that is still running', () => {
    for (const s of [2, 3, 4, 5, 7, 8, 65]) expect(isLiveOrderStatus(s)).toBe(true);
  });

  it('rejects delivered, closed and cancelled orders', () => {
    // 9 delivered, 10 closed, 11 canceled, 12 force_cancel, 13 force_closed
    for (const s of [9, 10, 11, 12, 13]) expect(isLiveOrderStatus(s)).toBe(false);
  });

  it('rejects a missing status rather than guessing', () => {
    expect(isLiveOrderStatus(null)).toBe(false);
    expect(isLiveOrderStatus(undefined)).toBe(false);
  });
});

describe('LATE_ORDER_COMPLAINT_TYPE', () => {
  /*
   * These are operations' OWN spellings, verified against the live production
   * option_lists on 2026-09-21. "Instore preparation late order" reads badly
   * and is displayed as "Late preparation in store" — correcting the stored
   * value would split the category across old and new rows.
   */
  it('uses ticket types that already exist', () => {
    expect(LATE_ORDER_COMPLAINT_TYPE.late_preparation).toBe('Instore preparation late order');
    expect(LATE_ORDER_COMPLAINT_TYPE.late_delivery).toBe('Late order');
  });
});

describe('LateOrderDecision', () => {
  const base = { orderId: '1313926', kind: 'late_delivery', action: 'ignored' } as const;

  it('requires a reason for BOTH actions', () => {
    expect(LateOrderDecision.safeParse({ ...base, reason: '' }).success).toBe(false);
    expect(LateOrderDecision.safeParse({ ...base, reason: '   ' }).success).toBe(false);
    expect(
      LateOrderDecision.safeParse({ ...base, action: 'compensated', reason: '' }).success,
    ).toBe(false);
  });

  it('accepts a decision that says why', () => {
    const parsed = LateOrderDecision.parse({ ...base, reason: '  driver reassigned  ' });
    expect(parsed.reason).toBe('driver reassigned');
  });
});

describe('couponOrderId', () => {
  /*
   * A coupon may stand alone (owner, 2026-09-21) — one given from the
   * late-orders queue has an order and no complaint behind it. Delivery needs
   * the ORDER, never the ticket.
   */
  it('reads the order from a ticket-less request', () => {
    expect(couponOrderId({ order_id: '1313926', ticket: null })).toBe('1313926');
  });

  it("prefers the TICKET's order when both exist", () => {
    // A stale id copied onto the request must never outrank the complaint's own.
    expect(couponOrderId({ order_id: '999', ticket: { order_id: '1313926' } })).toBe('1313926');
  });

  it('treats a blank column as no order at all', () => {
    expect(couponOrderId({ order_id: '   ', ticket: { order_id: '  ' } })).toBeNull();
    expect(couponOrderId({})).toBeNull();
  });
});

describe('parseYijiTimestamp', () => {
  /*
   * THE BUG THIS EXISTS FOR (staging, 2026-09-21).
   *
   * Yiji sends `2026-09-21T15:15:53.811204` with no zone, meaning Riyadh.
   * `Date.parse` reads an unmarked timestamp in the HOST's zone, so the same
   * string meant different instants on the Riyadh dev machine and in the UTC
   * container — and the container reported `minutesElapsed: -141`.
   *
   * Asserted as an absolute instant so the test says the same thing wherever
   * it runs: 15:15:53 Riyadh IS 12:15:53Z.
   */
  it('reads a naked timestamp as Riyadh, not as the host zone', () => {
    expect(parseYijiTimestamp('2026-09-21T15:15:53.811204')).toBe(
      Date.parse('2026-09-21T12:15:53.811Z'),
    );
  });

  it('respects an explicit zone when one is given', () => {
    expect(parseYijiTimestamp('2026-09-21T12:15:53Z')).toBe(Date.parse('2026-09-21T12:15:53Z'));
    expect(parseYijiTimestamp('2026-09-21T15:15:53+03:00')).toBe(
      Date.parse('2026-09-21T12:15:53Z'),
    );
  });

  it('refuses nonsense rather than inventing an instant', () => {
    for (const bad of [null, undefined, '', '   ', 'not a date'])
      expect(Number.isNaN(parseYijiTimestamp(bad))).toBe(true);
  });
});

describe('minutesSince', () => {
  const now = Date.parse('2026-09-21T13:00:00Z'); // 16:00 Riyadh

  it('measures a naked Riyadh timestamp correctly', () => {
    // Placed 15:15 Riyadh, read at 16:00 Riyadh = 45 minutes.
    expect(minutesSince('2026-09-21T15:15:00', now)).toBe(45);
  });

  /*
   * A clock disagreement must never produce a negative age: it is nonsense on
   * screen AND it sorts to the bottom of a list ordered by lateness, so the
   * most alarming-looking row would hide at the end.
   */
  it('never reports a negative age', () => {
    expect(minutesSince('2026-09-21T17:00:00', now)).toBe(0);
  });

  it('answers null for a timestamp it cannot read', () => {
    expect(minutesSince('', now)).toBeNull();
    expect(minutesSince(null, now)).toBeNull();
  });
});

describe('minutesSince — a finished order stops the clock', () => {
  /*
   * A closed order kept counting from creation to NOW: one measured 43,651
   * minutes (30 days), which is how long ago it happened, not how late it was.
   * The span a customer actually waited is creation -> orderStatusDate.
   */
  it('measures the SPAN when an end time is given', () => {
    const placed = '2026-09-21T13:00:00';
    const ended = parseYijiTimestamp('2026-09-21T14:15:00');
    expect(minutesSince(placed, ended)).toBe(75);
  });

  it('a month-old order reports its span, not its age', () => {
    const placed = '2026-08-22T13:22:00';
    const ended = parseYijiTimestamp('2026-08-22T14:30:00');
    const monthLater = parseYijiTimestamp('2026-09-21T13:22:00');
    expect(minutesSince(placed, ended)).toBe(68);
    // What the bug produced, for contrast — 30 days of minutes.
    expect(minutesSince(placed, monthLater)).toBe(43200);
  });
});
