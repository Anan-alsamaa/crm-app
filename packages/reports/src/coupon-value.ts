/*
 * What the coupons are WORTH, in riyals, split by who issued them.
 *
 * Separate from `coupon-approvals.ts`, which counts outcomes (approved /
 * rejected / pending). This counts money, and money needs its own rules.
 */

/** The fields a worth calculation needs off a coupon approval row. */
export interface CouponValueFact {
  status: string | null;
  issuingSide: string | null;
  discountCategory: string | null;
  /** Flat riyal amount, for an "Amount" coupon. */
  couponValue: number | null;
  /** Percentage off, for a "Percentage" coupon — worthless without the cap. */
  couponPercent: number | null;
  /** The ceiling a percentage coupon can cost. */
  maxDiscount: number | null;
}

export interface CouponSideTotal {
  /** "Operations", "Sara", … — whatever the issuing_side list holds. */
  side: string;
  count: number;
  sar: number;
}

export interface CouponWorth {
  /** Riyals on coupons that were actually APPROVED. */
  sar: number;
  count: number;
  /** Approved coupons, split by issuing side, biggest first. */
  bySide: CouponSideTotal[];
  /** Approved but with no computable riyal figure — see `couponSar`. */
  unpriced: number;
  /** Riyals sitting in the pending queue, i.e. not yet committed. */
  pendingSar: number;
  pendingCount: number;
}

/**
 * One coupon's worth in riyals, or `null` when it cannot be priced.
 *
 * An **Amount** coupon is its face value. A **Percentage** coupon has no
 * inherent riyal figure at all — 20% of an order nobody has placed yet is not
 * a number — so it is worth its CAP, which is the most it can ever cost. That
 * is the honest reading for a budget: what is the exposure.
 *
 * A percentage coupon with no cap returns null rather than 0. Zero would say
 * "this cost nothing", which is the opposite of the truth — an uncapped
 * percentage is unbounded. Those are counted as `unpriced` and reported
 * separately so the total never quietly absorbs them.
 *
 * Usage limit is deliberately NOT multiplied in. These are single-customer
 * compensation coupons; multiplying by a limit nobody has spent would report
 * money that does not exist.
 */
export function couponSar(f: CouponValueFact): number | null {
  const category = (f.discountCategory ?? '').trim().toLowerCase();
  if (category === 'percentage') {
    const cap = f.maxDiscount ?? 0;
    return cap > 0 ? cap : null;
  }
  // Everything else is treated as a flat amount — including a blank category,
  // which is what the older rows carry and which always meant riyals.
  const v = f.couponValue ?? 0;
  if (v > 0) return v;
  // A row with neither an amount nor a percentage is a broken coupon, not a
  // free one. `couponTermsProblems` refuses to create these now; the ones
  // already in the table must not be silently averaged in as zero.
  return (f.couponPercent ?? 0) > 0 ? null : 0;
}

const APPROVED = 'approved';
const PENDING = 'pending';

/** Total approved riyals, plus the same split by issuing side. */
export function couponWorth(facts: readonly CouponValueFact[]): CouponWorth {
  let sar = 0;
  let count = 0;
  let unpriced = 0;
  let pendingSar = 0;
  let pendingCount = 0;
  const sides = new Map<string, { count: number; sar: number }>();

  for (const f of facts) {
    const status = (f.status ?? '').trim().toLowerCase();
    const value = couponSar(f);

    if (status === PENDING) {
      pendingCount += 1;
      pendingSar += value ?? 0;
      continue;
    }
    // Rejected coupons cost nothing — they were never issued. Only approved
    // money is counted, which is what "issued" means.
    if (status !== APPROVED) continue;

    count += 1;
    if (value == null) {
      unpriced += 1;
    } else {
      sar += value;
    }

    // An unlabelled issuing side is its own bucket rather than being dropped:
    // money with no owner is exactly the thing somebody needs to see.
    const side = (f.issuingSide ?? '').trim() || 'Unspecified';
    const acc = sides.get(side) ?? { count: 0, sar: 0 };
    acc.count += 1;
    acc.sar += value ?? 0;
    sides.set(side, acc);
  }

  const bySide = [...sides.entries()]
    .map(([side, v]) => ({ side, count: v.count, sar: round2(v.sar) }))
    // Biggest spend first — the question is always "where is it going".
    .sort((a, b) => b.sar - a.sar || b.count - a.count || a.side.localeCompare(b.side));

  return {
    sar: round2(sar),
    count,
    bySide,
    unpriced,
    pendingSar: round2(pendingSar),
    pendingCount,
  };
}

/** Riyals to 2dp without float dust — 0.1 + 0.2 must not surface as 0.30000000000000004. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
