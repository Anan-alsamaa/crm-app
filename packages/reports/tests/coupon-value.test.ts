import { describe, it, expect } from 'vitest';
import { couponSar, couponWorth, type CouponValueFact } from '../src/coupon-value.js';

const fact = (over: Partial<CouponValueFact> = {}): CouponValueFact => ({
  status: 'approved',
  issuingSide: 'Operations',
  discountCategory: 'Amount',
  couponValue: 10,
  couponPercent: null,
  maxDiscount: null,
  ...over,
});

describe('couponSar', () => {
  it('prices an amount coupon at its face value', () => {
    expect(couponSar(fact({ couponValue: 25 }))).toBe(25);
  });

  it('prices a percentage coupon at its CAP, not its percentage', () => {
    // 20% of an order nobody has placed is not a number; the cap is the most
    // it can ever cost, which is the figure a budget cares about.
    expect(
      couponSar(
        fact({
          discountCategory: 'Percentage',
          couponValue: null,
          couponPercent: 20,
          maxDiscount: 55,
        }),
      ),
    ).toBe(55);
  });

  it('refuses to price an UNCAPPED percentage coupon rather than calling it zero', () => {
    // Zero would say "this cost nothing" about something unbounded.
    expect(
      couponSar(
        fact({
          discountCategory: 'Percentage',
          couponValue: null,
          couponPercent: 20,
          maxDiscount: null,
        }),
      ),
    ).toBeNull();
    expect(
      couponSar(
        fact({
          discountCategory: 'Percentage',
          couponValue: null,
          couponPercent: 20,
          maxDiscount: 0,
        }),
      ),
    ).toBeNull();
  });

  it('treats a blank category as riyals, which is what the older rows mean', () => {
    expect(couponSar(fact({ discountCategory: null, couponValue: 30 }))).toBe(30);
  });

  it('is case-insensitive about the category', () => {
    expect(
      couponSar(
        fact({
          discountCategory: 'PERCENTAGE',
          couponValue: null,
          couponPercent: 10,
          maxDiscount: 40,
        }),
      ),
    ).toBe(40);
  });
});

describe('couponWorth', () => {
  it('counts approved riyals only — a rejected coupon was never issued', () => {
    const w = couponWorth([
      fact({ status: 'approved', couponValue: 20 }),
      fact({ status: 'rejected', couponValue: 500 }),
      fact({ status: 'pending', couponValue: 7 }),
    ]);
    expect(w.sar).toBe(20);
    expect(w.count).toBe(1);
  });

  it('reports pending money separately, because it is not committed yet', () => {
    const w = couponWorth([
      fact({ status: 'approved', couponValue: 20 }),
      fact({ status: 'pending', couponValue: 7 }),
      fact({ status: 'pending', couponValue: 3 }),
    ]);
    expect(w.pendingSar).toBe(10);
    expect(w.pendingCount).toBe(2);
    expect(w.sar).toBe(20);
  });

  it('splits by issuing side, biggest spend first', () => {
    const w = couponWorth([
      fact({ issuingSide: 'Operations', couponValue: 10 }),
      fact({ issuingSide: 'Sara', couponValue: 40 }),
      fact({ issuingSide: 'Operations', couponValue: 5 }),
    ]);
    expect(w.bySide).toEqual([
      { side: 'Sara', count: 1, sar: 40 },
      { side: 'Operations', count: 2, sar: 15 },
    ]);
  });

  it('buckets an unlabelled issuing side rather than dropping it', () => {
    // Money with no owner is exactly what somebody needs to see.
    const w = couponWorth([fact({ issuingSide: null, couponValue: 12 })]);
    expect(w.bySide).toEqual([{ side: 'Unspecified', count: 1, sar: 12 }]);
  });

  it('counts unpriced coupons separately instead of absorbing them into the total', () => {
    const w = couponWorth([
      fact({ couponValue: 20 }),
      fact({
        discountCategory: 'Percentage',
        couponValue: null,
        couponPercent: 15,
        maxDiscount: null,
      }),
    ]);
    expect(w.sar).toBe(20);
    expect(w.count).toBe(2);
    expect(w.unpriced).toBe(1);
  });

  it('adds riyals without float dust', () => {
    const w = couponWorth([fact({ couponValue: 0.1 }), fact({ couponValue: 0.2 })]);
    expect(w.sar).toBe(0.3);
  });

  it('returns an honest zero for no coupons at all', () => {
    const w = couponWorth([]);
    expect(w).toEqual({
      sar: 0,
      count: 0,
      bySide: [],
      unpriced: 0,
      pendingSar: 0,
      pendingCount: 0,
      rejectedSar: 0,
      rejectedCount: 0,
      askedSar: 0,
      trend: [],
    });
  });
});

describe('rejected coupons', () => {
  it('are totalled separately and never counted as spend', () => {
    // Nothing left the business — but the pipeline reads wrong without them.
    // "13 approved" means something different next to 2 rejected than 200.
    const w = couponWorth([
      fact({ status: 'approved', couponValue: 20 }),
      fact({ status: 'rejected', couponValue: 500 }),
      fact({ status: 'rejected', couponValue: 30 }),
    ]);
    expect(w.sar).toBe(20);
    expect(w.rejectedSar).toBe(530);
    expect(w.rejectedCount).toBe(2);
  });

  it('keeps a rejected coupon out of the issuing-side split', () => {
    const w = couponWorth([fact({ status: 'rejected', issuingSide: 'Sara', couponValue: 99 })]);
    expect(w.bySide).toEqual([]);
  });
});

describe('askedSar', () => {
  it('is every riyal requested — approved plus awaiting plus refused', () => {
    const w = couponWorth([
      fact({ status: 'approved', couponValue: 20 }),
      fact({ status: 'pending', couponValue: 5 }),
      fact({ status: 'rejected', couponValue: 75 }),
    ]);
    expect(w.askedSar).toBe(100);
    // The ring on the dashboard divides spend by this, so the two must agree.
    expect(w.sar / w.askedSar).toBeCloseTo(0.2);
  });
});

describe('trend', () => {
  it('buckets approved riyals by day, oldest first', () => {
    const w = couponWorth([
      fact({ couponValue: 10, createdAt: '2026-08-02T10:00:00Z' }),
      fact({ couponValue: 5, createdAt: '2026-08-02T18:00:00Z' }),
      fact({ couponValue: 40, createdAt: '2026-08-04T09:00:00Z' }),
    ]);
    expect(w.trend.map((d) => [d.day, d.sar])).toEqual([
      ['2026-08-02', 15],
      // The quiet day is PRESENT at zero — a line drawn only through the days
      // that had coupons would compress a quiet stretch to nothing.
      ['2026-08-03', 0],
      ['2026-08-04', 40],
    ]);
  });

  it('leaves rejected and pending out of the trend', () => {
    const w = couponWorth([
      fact({ status: 'approved', couponValue: 10, createdAt: '2026-08-02T10:00:00Z' }),
      fact({ status: 'rejected', couponValue: 999, createdAt: '2026-08-02T11:00:00Z' }),
      fact({ status: 'pending', couponValue: 50, createdAt: '2026-08-02T12:00:00Z' }),
    ]);
    expect(w.trend).toEqual([{ day: '2026-08-02', sar: 10, count: 1 }]);
  });

  it('is empty when nothing carries a date', () => {
    const w = couponWorth([fact({ couponValue: 10 })]);
    expect(w.trend).toEqual([]);
  });
});
