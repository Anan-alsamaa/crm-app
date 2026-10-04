import { describe, it, expect } from 'vitest';
import { mergeLateOrders, causeLabel } from '../src/late-delivery.js';
import type { LateOrderDecisionRow, LateOrderRow } from '../src/late-delivery.js';

/**
 * THE ORDER'S CREATION DATE IS THE ORDER'S, NOT THE DECISION'S.
 *
 * Reported by operations (EMA-26 §5, 2026-10-04): *"In the Late Orders screen,
 * the Order Creation Date currently changes based on the selected date range.
 * The actual order creation date should remain fixed and accurate, regardless
 * of the date range selected for filtering."*
 *
 * THE RANGE WAS NEVER DOING IT. `date_created` meant two different things
 * depending on the row:
 *
 *   - a DECIDED row spreads the decision, so it carried the time an AGENT
 *     acted;
 *   - a PENDING row takes `q.placedAt`, the time the ORDER was placed.
 *
 * One column, labelled "Creation time", showing two different facts. Widening
 * the range pulls in decisions taken on other days, so the dates appear to
 * move — which is exactly what was reported.
 *
 * Measured on staging before the fix: order 1323103 was placed 2026-09-28 and
 * the register showed 2026-10-04, the day it was compensated. Six days out.
 */

const decision = (over: Partial<LateOrderDecisionRow> = {}): LateOrderDecisionRow =>
  ({
    id: 'dec-1',
    order_id: '1323103',
    kind: 'late_delivery',
    action: 'compensated',
    reason: 'driver was late',
    action_taken: 'voucher issued',
    minutes_elapsed: 90,
    brand_name: 'Poshak',
    restaurant_name: 'Riyadh - Park',
    /* WHEN THE AGENT DECIDED — six days after the order. */
    date_created: '2026-10-04T10:37:29.779Z',
    decided_by: null,
    ticket: null,
    ...over,
  }) as LateOrderDecisionRow;

const queued = (over: Partial<LateOrderRow> = {}): LateOrderRow =>
  ({
    orderId: '1399999',
    status: 'force_closed',
    minutesElapsed: 120,
    live: false,
    /* WHEN THE ORDER WAS PLACED. */
    placedAt: '2026-10-02T12:37:18.693682',
    brandName: 'La Casa Pasta',
    restaurantName: 'Kharj - Centro',
    customerPhone: '0541095051',
    ...over,
  }) as LateOrderRow;

describe('a decided row', () => {
  /* THE BUG, and the real numbers from staging. */
  it('reports when the ORDER was placed, not when it was decided', () => {
    const [row] = mergeLateOrders(
      [decision({ order_snapshot: { placedAt: '2026-09-28T12:23:57.305207' } as never })],
      [],
    );
    expect(row?.order_placed_at).toBe('2026-09-28T12:23:57.305207');
    /* And the decision date is still THERE — it is real data the agent and
       acted-on columns legitimately report. It is simply not the creation
       time. */
    expect(row?.date_created).toBe('2026-10-04T10:37:29.779Z');
  });

  /*
   * THE SNAPSHOT FIRST, because it is immutable: it is what the order was when
   * the decision was taken, and Yiji keeps mutating an order afterwards.
   */
  it('prefers the snapshot over the live queue', () => {
    const [row] = mergeLateOrders(
      [decision({ order_snapshot: { placedAt: '2026-09-28T00:00:00' } as never })],
      [queued({ orderId: '1323103', placedAt: '2026-09-29T00:00:00' })],
    );
    expect(row?.order_placed_at).toBe('2026-09-28T00:00:00');
  });

  /*
   * THE LIVE QUEUE SECOND, for a decision taken before snapshots captured
   * `placedAt` — there are such rows, and staging has one.
   */
  it('falls back to the live queue when the snapshot has no time', () => {
    const [row] = mergeLateOrders(
      [decision({ order_id: '1323103', order_snapshot: null })],
      [queued({ orderId: '1323103', placedAt: '2026-09-30T08:00:00' })],
    );
    expect(row?.order_placed_at).toBe('2026-09-30T08:00:00');
  });

  /*
   * AND NULL WHEN NOTHING KNOWS — the column then falls back to the decision
   * date rather than rendering a dash, because a blank where a date belongs
   * reads as missing data and the decision date is at least an upper bound on
   * when the order existed.
   */
  it('answers null when neither source has a time', () => {
    const [row] = mergeLateOrders([decision({ order_snapshot: null })], []);
    expect(row?.order_placed_at).toBeNull();
  });

  /* Whitespace is not a time. */
  it('ignores a blank snapshot time', () => {
    const [row] = mergeLateOrders(
      [decision({ order_id: '1323103', order_snapshot: { placedAt: '   ' } as never })],
      [queued({ orderId: '1323103', placedAt: '2026-09-30T08:00:00' })],
    );
    expect(row?.order_placed_at).toBe('2026-09-30T08:00:00');
  });
});

describe('a pending row', () => {
  /* The two are the same time here — but it is still STATED, so every row in
     the register answers "when was this order placed?" from one field. */
  it('carries the order time in both fields', () => {
    const [row] = mergeLateOrders([], [queued()]);
    expect(row?.order_placed_at).toBe('2026-10-02T12:37:18.693682');
    expect(row?.date_created).toBe('2026-10-02T12:37:18.693682');
  });
});

/**
 * THE CAUSE, READABLE, and shared rather than copied.
 *
 * It was written once in the admin register and was about to be written again
 * for the agent portal's ticket card. Two copies of a display rule drift, and
 * the two screens are meant to read the same.
 */
describe('spelling out a cause', () => {
  it.each([
    ['late_delivery', 'Late delivery'],
    ['late_preparation', 'Late preparation'],
    ['wecare', 'Wecare'],
  ])('%s reads as %s', (input, expected) => {
    expect(causeLabel(input)).toBe(expected);
  });

  /* A cause operations add tomorrow announces itself without anyone editing
     code — that is the whole point of the fallback. */
  it('handles a cause nobody has seen before', () => {
    expect(causeLabel('branch_system_down')).toBe('Branch system down');
  });

  it('leaves an empty value alone rather than returning something odd', () => {
    expect(causeLabel('')).toBe('');
    expect(causeLabel('   ')).toBe('   ');
  });
});
