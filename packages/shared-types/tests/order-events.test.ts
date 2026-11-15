import { describe, expect, it } from 'vitest';
import {
  OrderEvent,
  OrderEventsBody,
  applyOrderEvent,
  isHandledOrderEvent,
  lateRowsFromLive,
  liveOrderToLateRow,
  orderEventsOf,
  parseLiveOrders,
  pollRowToLiveOrder,
  type LiveOrder,
} from '../src/order-events.js';

/**
 * ORDER EVENTS (owner, 2026-11-15): the platform tells the CRM every order
 * change; the CRM times the order itself and builds the late-orders board
 * from its own live table - no poll.
 */
const T = (min: number) => new Date(Date.parse('2026-11-15T10:00:00+03:00') + min * 60_000);
const iso = (min: number) => T(min).toISOString();

const ev = (over: Partial<OrderEvent['order']> = {}, at = 0, id = `e${at}`): OrderEvent => ({
  id,
  type: 'order.status_changed',
  at: iso(at),
  order: {
    orderId: '1400001',
    status: 'in_kitchen',
    isOpen: true,
    orderType: 'delivery',
    placedAt: iso(0),
    restaurantId: '501',
    restaurantName: 'Riyadh - Masief Plaza',
    brandName: 'La Casa Pasta',
    customer: { id: 'u-1', name: 'Sara', phone: '+966501234567' },
    total: 88,
    ...over,
  },
});

describe('the event contract', () => {
  it('accepts one event or a batch, and rejects a bare local time', () => {
    expect(orderEventsOf(OrderEventsBody.parse(ev()))).toHaveLength(1);
    expect(orderEventsOf(OrderEventsBody.parse({ events: [ev(), ev({}, 5, 'e5')] }))).toHaveLength(
      2,
    );
    const bad = OrderEvent.safeParse({ ...ev(), at: '2026-11-15 13:00:00' });
    expect(bad.success).toBe(false);
  });
  it('acts on order.created / order.status_changed, ignores the rest', () => {
    expect(isHandledOrderEvent('order.created')).toBe(true);
    expect(isHandledOrderEvent('order.status_changed')).toBe(true);
    expect(isHandledOrderEvent('coupon.used')).toBe(false);
  });
});

describe('applying events to a live order', () => {
  it('builds the order from its first event and keeps the first time of every status', () => {
    const o = applyOrderEvent(null, ev({ status: 'placed' }, 0));
    expect(o).toMatchObject({
      orderId: '1400001',
      status: 'placed',
      isOpen: true,
      closedAt: null,
      source: 'event',
      customerPhone: '+966501234567',
    });
    const o2 = applyOrderEvent(o, ev({ status: 'in_delivery' }, 40));
    expect(o2.status).toBe('in_delivery');
    expect(o2.firstAt).toEqual({ placed: iso(0), in_delivery: iso(40) });
    /* `arrived` can repeat on Yiji: the FIRST time is the leg. */
    const o3 = applyOrderEvent(
      applyOrderEvent(o2, ev({ status: 'arrived' }, 50)),
      ev({ status: 'arrived' }, 58),
    );
    expect(o3.firstAt.arrived).toBe(iso(50));
  });
  it('an older event never moves the status back; a close is final', () => {
    const o = applyOrderEvent(null, ev({ status: 'in_delivery' }, 40));
    const late = applyOrderEvent(o, ev({ status: 'in_kitchen' }, 20));
    expect(late.status).toBe('in_delivery');
    expect(late.firstAt.in_kitchen).toBe(iso(20));
    const closed = applyOrderEvent(late, ev({ status: 'delivered', isOpen: false }, 70));
    expect(closed).toMatchObject({ isOpen: false, closedAt: iso(70), status: 'delivered' });
    const after = applyOrderEvent(closed, ev({ status: 'in_delivery' }, 75));
    expect(after).toMatchObject({ isOpen: false, closedAt: iso(70) });
  });
});

describe('the board rows', () => {
  it('a live order counts to now; a finished one stops at its close', () => {
    const live = applyOrderEvent(null, ev({ status: 'in_kitchen' }, 5));
    expect(liveOrderToLateRow(live, T(75).getTime())).toMatchObject({
      orderId: '1400001',
      minutesElapsed: 75,
      live: true,
      brandName: 'La Casa Pasta',
      restaurantId: '501',
      customerName: 'Sara',
      externalCustomerId: 'u-1',
      total: 88,
    });
    const done = applyOrderEvent(live, ev({ status: 'delivered', isOpen: false }, 70));
    expect(liveOrderToLateRow(done, T(300).getTime())).toMatchObject({
      minutesElapsed: 70,
      live: false,
      closedAt: iso(70),
    });
  });
  it('delivery masters past the threshold only, longest first; sub-orders and old rows left out', () => {
    const a = applyOrderEvent(null, ev({ orderId: 'a' }, 0));
    const b = applyOrderEvent(null, ev({ orderId: 'b', placedAt: iso(-30) }, 0));
    const pickup = applyOrderEvent(
      null,
      ev({ orderId: 'p', orderType: 'pickup', placedAt: iso(-60) }, 0),
    );
    const sub = applyOrderEvent(
      null,
      ev({ orderId: 's', parentOrderId: 'b', placedAt: iso(-60) }, 0),
    );
    const young = applyOrderEvent(null, ev({ orderId: 'y', placedAt: iso(50) }, 50));
    const old = applyOrderEvent(null, ev({ orderId: 'o', placedAt: iso(-7 * 60) }, -7 * 60));
    const rows = lateRowsFromLive([a, b, pickup, sub, young, old], 60, T(65).getTime());
    expect(rows.map((r) => [r.orderId, r.minutesElapsed])).toEqual([
      ['b', 95],
      ['a', 65],
    ]);
  });
  it('a reconciliation row becomes a live order the events may later take over', () => {
    const o = pollRowToLiveOrder(
      {
        orderId: 'r1',
        status: '8',
        minutesElapsed: 70,
        live: true,
        placedAt: iso(-70),
        brandName: 'Okashi',
        customerPhone: '0501234567',
        externalCustomerId: 'u-9',
      },
      T(0).getTime(),
    );
    expect(o).toMatchObject({ source: 'poll', isOpen: true, closedAt: null, customerId: 'u-9' });
    expect(parseLiveOrders({ r1: JSON.stringify(o), junk: '{nope' })).toHaveLength(1);
  });
});

const _typeCheck: LiveOrder | null = null;
void _typeCheck;
