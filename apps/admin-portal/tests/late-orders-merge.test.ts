import { describe, expect, it } from 'vitest';
import { mergeLateOrders, type LateOrderDecisionRow } from '../src/features/late-orders/api.js';
import type { LateOrderRow } from '@yiji/shared-types';

/**
 * A PENDING LATE ORDER HAS NO DATABASE ROW (owner, 2026-09-29).
 *
 * It exists only in Yiji's queue until somebody comments on it or gives a
 * coupon. So the register is a MERGE: decisions describe what has been acted
 * on, and the queue supplies everything nobody has touched.
 *
 * Without this the report could only ever show orders already acted on, which
 * is the opposite of what "pending" means.
 */
const decision = (over: Partial<LateOrderDecisionRow> = {}): LateOrderDecisionRow => ({
  id: 'dec-1',
  order_id: '100',
  kind: 'late_preparation',
  action: 'compensated',
  reason: 'gave a coupon',
  action_taken: null,
  minutes_elapsed: 70,
  brand_name: 'Poshak',
  restaurant_name: 'Nada Plaza',
  date_created: '2026-09-28T12:00:00Z',
  decided_by: null,
  ticket: null,
  ...over,
});

const queued = (over: Partial<LateOrderRow> = {}): LateOrderRow =>
  ({
    orderId: '200',
    status: 'force_closed',
    minutesElapsed: 65,
    placedAt: '2026-09-28T11:00:00',
    brandName: 'Casa Pasta',
    restaurantName: 'Turki Al Awal',
    customerPhone: '0536223222',
    ...over,
  }) as LateOrderRow;

describe('mergeLateOrders', () => {
  it('brings in a queue order nobody has touched, as pending', () => {
    const out = mergeLateOrders([], [queued()]);
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe('pending');
    expect(out[0]!.pendingOnly).toBe(true);
    expect(out[0]!.order_id).toBe('200');
  });

  /*
   * DECISIONS WIN. An order that has been acted on is described by its
   * decision; the queue must not add a second row for the same order — that is
   * the duplication the register just stopped producing.
   */
  it('does not duplicate an order that already has a decision', () => {
    const out = mergeLateOrders([decision({ order_id: '200' })], [queued({ orderId: '200' })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe('handled');
    expect(out[0]!.pendingOnly).toBe(false);
  });

  it('keeps both when they are different orders', () => {
    const out = mergeLateOrders([decision({ order_id: '100' })], [queued({ orderId: '200' })]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.order_id).sort()).toEqual(['100', '200']);
  });

  /* The three states, from one merged list. */
  it('reports each state from what is recorded', () => {
    const out = mergeLateOrders(
      [
        decision({ id: 'a', order_id: '100', action: 'compensated' }),
        decision({ id: 'b', order_id: '101', action: 'commented', reason: 'chased branch' }),
      ],
      [queued({ orderId: '102' })],
    );
    const byOrder = new Map(out.map((r) => [r.order_id, r.state]));
    expect(byOrder.get('100')).toBe('handled');
    expect(byOrder.get('101')).toBe('commented');
    expect(byOrder.get('102')).toBe('pending');
  });

  /*
   * THE ORDER'S OWN STATUS IS NOT THE HANDLING STATE. A force-closed order can
   * still be pending here, because nobody at WeCare has touched it.
   */
  it('carries the order status separately from the handling state', () => {
    const out = mergeLateOrders([], [queued({ status: 'force_closed' })]);
    expect(out[0]!.order_status).toBe('force_closed');
    expect(out[0]!.state).toBe('pending');
  });

  /* A pending row is dated by the ORDER, not by "now" — otherwise every
     pending order would sort to the top of a report about when things
     happened. */
  it('dates a pending row by when the order was placed', () => {
    const out = mergeLateOrders([], [queued({ placedAt: '2026-09-28T11:00:00' })]);
    expect(out[0]!.date_created).toBe('2026-09-28T11:00:00');
  });

  it('sorts newest first across both sources', () => {
    const out = mergeLateOrders(
      [decision({ order_id: '100', date_created: '2026-09-28T09:00:00Z' })],
      [queued({ orderId: '200', placedAt: '2026-09-28T18:00:00Z' })],
    );
    expect(out.map((r) => r.order_id)).toEqual(['200', '100']);
  });

  it('gives a pending row an id that cannot collide with a decision', () => {
    const out = mergeLateOrders([], [queued({ orderId: '200' })]);
    expect(out[0]!.id).toBe('pending:200');
  });

  it('is just the decisions when the queue could not be read', () => {
    const out = mergeLateOrders([decision()], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.pendingOnly).toBe(false);
  });
});
