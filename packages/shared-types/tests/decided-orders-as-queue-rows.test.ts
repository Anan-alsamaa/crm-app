import { describe, it, expect } from 'vitest';
import { decidedOrdersAsQueueRows, type LateOrderRow } from '../src/late-delivery.js';

/**
 * A SCREEN THAT RENDERS ONLY THE LIVE QUEUE LOSES ITS OWN HISTORY.
 *
 * Yiji's late-orders queue answers with orders currently past the threshold.
 * An order drops out of that answer once it is old enough — but the DECISION we
 * recorded against it is a row in our own database and never drops out.
 *
 * Operations reported the consequence (2026-10-03): the user portal showed "no
 * data for yesterday or day before", while the same orders sat plainly in the
 * admin register, which has always merged the two sources. Checked against live
 * production at the time: 124 decisions existed, 16 of them on 1 Oct and 14 on
 * 30 Sep. The data was there; the screen could not see it.
 *
 * This rebuilds those orders in the QUEUE's shape, so a page already built
 * around `LateOrderRow` can simply concatenate them and leave its filters,
 * pickers, business-day cut and table reading one kind of row.
 */

const snap = (over: Record<string, unknown> = {}) => ({
  orderId: '1328524',
  status: 'closed',
  placedAt: '2026-10-01T21:04:24.000Z',
  brandName: 'La Casa Pasta',
  restaurantName: 'Al Qatif - Al Quds',
  restaurantId: '174',
  customerPhone: '0546401994',
  customerName: 'Noura',
  total: 81,
  ...over,
});

const decision = (over: Record<string, unknown> = {}) => ({
  order_id: '1328524',
  minutes_elapsed: 101,
  brand_name: 'La Casa Pasta',
  restaurant_name: 'Al Qatif - Al Quds',
  date_created: '2026-10-01T22:52:06.000Z',
  order_snapshot: snap(),
  ...over,
});

const queued = (over: Partial<LateOrderRow> = {}): LateOrderRow => ({
  orderId: '999',
  status: 'preparing',
  minutesElapsed: 12,
  placedAt: '2026-10-03T08:00:00.000Z',
  ...over,
});

describe('rebuilding a decided order the queue no longer returns', () => {
  /* THE WHOLE POINT. */
  it('puts it back on the list', () => {
    const out = decidedOrdersAsQueueRows([decision()], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.orderId).toBe('1328524');
  });

  it('carries what the snapshot captured', () => {
    const [r] = decidedOrdersAsQueueRows([decision()], []);
    expect(r).toMatchObject({
      status: 'closed',
      minutesElapsed: 101,
      brandName: 'La Casa Pasta',
      restaurantName: 'Al Qatif - Al Quds',
      restaurantId: '174',
      customerPhone: '0546401994',
      customerName: 'Noura',
      total: 81,
    });
  });

  /*
   * WHEN THE ORDER WAS PLACED, NOT WHEN SOMEBODY DECIDED.
   *
   * The business-day cut keys on `placedAt`. Using the decision time would file
   * an order under the night an agent got round to looking at it — so a late
   * order from Tuesday evening would appear on Wednesday's list.
   */
  it('is dated by the order, not by the decision', () => {
    const [r] = decidedOrdersAsQueueRows([decision()], []);
    expect(r!.placedAt).toBe('2026-10-01T21:04:24.000Z');
  });

  /* Better a row dated by its decision than no row at all: a handful of rows
     predate the snapshot column entirely. */
  it('falls back to the decision time when there is no snapshot', () => {
    const [r] = decidedOrdersAsQueueRows([decision({ order_snapshot: null })], []);
    expect(r!.placedAt).toBe('2026-10-01T22:52:06.000Z');
    /* And still names the brand, which the decision carries in its own right. */
    expect(r!.brandName).toBe('La Casa Pasta');
  });

  /* It is no longer in the queue, so the clock is not running. The UI reads
     this to stop implying otherwise. */
  it('is marked not live', () => {
    expect(decidedOrdersAsQueueRows([decision()], [])[0]!.live).toBe(false);
  });
});

describe('an order that is still in the queue', () => {
  /*
   * THE LIVE ROW WINS. It is current; a snapshot is a copy of one moment. A
   * duplicate here would show the same order twice and double every count on
   * the screen.
   */
  it('is not rebuilt alongside itself', () => {
    const out = decidedOrdersAsQueueRows([decision()], [queued({ orderId: '1328524' })]);
    expect(out).toHaveLength(0);
  });

  it('does not block a different order from being rebuilt', () => {
    const out = decidedOrdersAsQueueRows([decision()], [queued({ orderId: '777' })]);
    expect(out.map((r) => r.orderId)).toEqual(['1328524']);
  });
});

describe('two decisions on one order', () => {
  /*
   * The decisions query returns NEWEST FIRST, and a re-decision writes a new
   * row rather than editing the old one. Rebuilding both would put the order on
   * screen twice — the same doubling that once made the admin register
   * double-count orders 1323103 and 1323132.
   */
  it('yields one row, from the newest', () => {
    const out = decidedOrdersAsQueueRows(
      [
        decision({ minutes_elapsed: 101 }),
        decision({ minutes_elapsed: 40, date_created: '2026-09-30T10:00:00.000Z' }),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.minutesElapsed).toBe(101);
  });
});

describe('a decision with nothing to rebuild from', () => {
  /* No order id, nothing to merge on and nothing to show. */
  it('is skipped rather than rendered as a blank row', () => {
    expect(decidedOrdersAsQueueRows([decision({ order_id: null })], [])).toHaveLength(0);
    expect(decidedOrdersAsQueueRows([decision({ order_id: '   ' })], [])).toHaveLength(0);
  });

  /*
   * NOTHING IS INVENTED. A field neither the snapshot nor the decision holds is
   * left undefined, so the column reads empty instead of claiming a value
   * nobody recorded.
   */
  it('leaves unknown fields undefined, not guessed', () => {
    const [r] = decidedOrdersAsQueueRows(
      [{ order_id: '55', order_snapshot: null, minutes_elapsed: null, date_created: null }],
      [],
    );
    expect(r!.status).toBe('');
    expect(r!.minutesElapsed).toBe(0);
    expect(r!.customerPhone).toBeUndefined();
    expect(r!.brandName).toBeUndefined();
    expect(r!.total).toBeUndefined();
  });
});
