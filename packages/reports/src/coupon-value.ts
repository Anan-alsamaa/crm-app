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
  /** ISO timestamp the coupon was raised. Optional — only the trend needs it. */
  createdAt?: string | null;
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
  /**
   * Riyals REFUSED. Not spend — nothing left the business — but the pipeline
   * reads wrong without it: "13 approved" means something different next to
   * 2 rejected than next to 200, and a split bar drawn from approved and
   * pending alone would quietly imply everything asked for was granted.
   */
  rejectedSar: number;
  rejectedCount: number;
  /**
   * Every riyal that was ASKED for — approved plus awaiting plus refused.
   *
   * The denominator for "how freely is compensation being granted", which is
   * the question a spend figure on its own cannot answer. Kept here rather
   * than added up at the call site so the parts and the whole can never drift.
   */
  askedSar: number;
  /**
   * Approved riyals per DAY, oldest first, with empty days filled in.
   *
   * Filled rather than sparse because a line drawn through only the days that
   * had coupons compresses a quiet fortnight into the same width as a busy
   * one, which is the opposite of what a trend is for.
   */
  trend: CouponDayTotal[];
}

export interface CouponDayTotal {
  /** Local `YYYY-MM-DD`. */
  day: string;
  sar: number;
  count: number;
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
const REJECTED = 'rejected';

/** Total approved riyals, plus the same split by issuing side. */
export function couponWorth(facts: readonly CouponValueFact[]): CouponWorth {
  let sar = 0;
  let count = 0;
  let unpriced = 0;
  let pendingSar = 0;
  let pendingCount = 0;
  let rejectedSar = 0;
  let rejectedCount = 0;
  const sides = new Map<string, { count: number; sar: number }>();
  const days = new Map<string, { sar: number; count: number }>();

  for (const f of facts) {
    const status = (f.status ?? '').trim().toLowerCase();
    const value = couponSar(f);

    if (status === PENDING) {
      pendingCount += 1;
      pendingSar += value ?? 0;
      continue;
    }
    if (status === REJECTED) {
      rejectedCount += 1;
      rejectedSar += value ?? 0;
      continue;
    }
    // Rejected coupons cost nothing — they were never issued. Only approved
    // money counts toward `sar`, which is what "issued" means.
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

    const day = (f.createdAt ?? '').slice(0, 10);
    if (day) {
      const d = days.get(day) ?? { sar: 0, count: 0 };
      d.sar += value ?? 0;
      d.count += 1;
      days.set(day, d);
    }
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
    rejectedSar: round2(rejectedSar),
    rejectedCount,
    askedSar: round2(sar + pendingSar + rejectedSar),
    trend: fillDays(days),
  };
}

/** Riyals to 2dp without float dust — 0.1 + 0.2 must not surface as 0.30000000000000004. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Sparse day buckets to a continuous oldest-first series, zeroes included. */
function fillDays(days: Map<string, { sar: number; count: number }>): CouponDayTotal[] {
  const keys = [...days.keys()].sort();
  if (keys.length === 0) return [];
  const out: CouponDayTotal[] = [];
  const cursor = new Date(`${keys[0]}T00:00:00Z`);
  const last = new Date(`${keys[keys.length - 1]}T00:00:00Z`);
  // Guard against a nonsense range producing an unbounded loop: a year of
  // daily points is already far more than the card can draw.
  for (let i = 0; cursor <= last && i < 400; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    const hit = days.get(key);
    out.push({ day: key, sar: round2(hit?.sar ?? 0), count: hit?.count ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
