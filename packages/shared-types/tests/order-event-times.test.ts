import { describe, expect, it } from 'vitest';
import { orderEventTimes } from '../src/late-delivery.js';

/**
 * THE FOUR ORDER TIMES, from the real status history.
 *
 * The fixture is ORDER 1323407 as production actually holds it (read
 * 2026-09-29). It is the order the owner reported, and it exercises both
 * fallbacks at once: it has BOTH `closed` and `force_closed`, and it has NO
 * `ready_to_pickup`.
 */
const ORDER_1323407 = {
  initial: '2026-09-28T16:23:49.681648',
  pending_payment: '2026-09-28T16:23:50.531719',
  paid: '2026-09-28T16:24:02.099405',
  finding_driver: '2026-09-28T16:24:02.752911',
  driver_accepted: '2026-09-28T16:26:22.906944',
  pos_accepted: '2026-09-28T16:26:25.230297',
  in_kitchen: '2026-09-28T16:26:25.676545',
  arrived: '2026-09-28T16:48:47.799643',
  in_delivery: '2026-09-28T17:09:22.45787',
  delivered: '2026-09-28T17:30:38.34654',
  closed: '2026-09-28T17:30:39.928454',
  // FIVE HOURS after the close. Reading the order's current status date picked
  // this up and reported a 365-minute service time.
  force_closed: '2026-09-28T22:31:24.124805',
};

describe('orderEventTimes — order 1323407, the reported case', () => {
  it('measures service time to CLOSED, not to force-closed', () => {
    expect(orderEventTimes(ORDER_1323407).serviceMinutes).toBe(64);
  });

  it('driver arrival is driver-accepted to arrived', () => {
    expect(orderEventTimes(ORDER_1323407).driverArrivalMinutes).toBe(22);
  });

  it('delivery is in-delivery to closed', () => {
    expect(orderEventTimes(ORDER_1323407).deliveryMinutes).toBe(21);
  });

  it('preparation falls back to in-delivery when there is no ready-to-pickup', () => {
    /* 42, not 43: the gap is 42.95 minutes and every duration here FLOORS,
       so a part-minute is not counted. Consistent with `minutesSince` and
       `serviceMinutes`, which have always worked this way. */
    expect(orderEventTimes(ORDER_1323407).preparationMinutes).toBe(42);
  });
});

describe('orderEventTimes — the rules', () => {
  it('uses force-closed only when there is no close', () => {
    const { closed, ...noClose } = ORDER_1323407;
    expect(closed).toBeTruthy();
    expect(orderEventTimes(noClose).serviceMinutes).toBe(365);
  });

  it('prefers ready-to-pickup over in-delivery when both exist', () => {
    const at = { ...ORDER_1323407, ready_to_pickup: '2026-09-28T16:56:25.230297' };
    expect(orderEventTimes(at).preparationMinutes).toBe(30);
  });

  it('prefers arrived over in-delivery when both exist', () => {
    // 1323407 has both: arrived 16:48:47 beats in_delivery 17:09:22.
    expect(orderEventTimes(ORDER_1323407).driverArrivalMinutes).toBe(22);
  });

  /* A live order has not finished, so its service time runs to NOW — that is
     what makes the column tick on the queue. */
  it('runs service time to now while the order is unfinished', () => {
    const { closed, force_closed, ...live } = ORDER_1323407;
    expect(closed && force_closed).toBeTruthy();
    const now = Date.parse('2026-09-28T17:26:22.906944Z') - 3 * 3600_000;
    expect(orderEventTimes(live, now).serviceMinutes).toBe(60);
  });

  /* Null, not zero: a blank cell says "not known", a zero says "instant". */
  it('returns null for a time whose events are missing', () => {
    const t = orderEventTimes({});
    expect(t.serviceMinutes).toBeNull();
    expect(t.driverArrivalMinutes).toBeNull();
    expect(t.deliveryMinutes).toBeNull();
    expect(t.preparationMinutes).toBeNull();
  });

  it('never reports a negative duration from out-of-order events', () => {
    const t = orderEventTimes({
      driver_accepted: '2026-09-28T18:00:00',
      closed: '2026-09-28T17:00:00',
    });
    expect(t.serviceMinutes).toBe(0);
  });
});
