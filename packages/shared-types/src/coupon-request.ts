import { z } from 'zod';

/**
 * A compensation coupon an agent asks an admin to approve.
 *
 * "Compensation" is the whole process; the "coupon" is what gets assigned at the
 * end of it. They are the same thing at different stages, which is why one
 * schema covers both and the status says where it has got to.
 *
 * The dropdown values (issuing side, delivery type, coupon type, discount
 * category) are NOT enums here on purpose. They live in `option_lists` and are
 * edited by operations in the admin portal, so pinning them in code would mean
 * a deploy every time a new issuing side is added — exactly what that page
 * exists to avoid. They are validated as non-empty strings and checked against
 * the live list at the point of use.
 */

/** Where a request has got to. */
export const CouponRequestStatus = z.enum([
  /** The agent has asked; nobody has looked yet. */
  'pending',
  /** An admin changed the agent's values and approved in one action. */
  'edited',
  'approved',
  'rejected',
  /** Approved AND pushed to Yiji, which owns the final assignment. */
  'assigned',
]);
export type CouponRequestStatus = z.infer<typeof CouponRequestStatus>;

/**
 * What the agent fills in.
 *
 * Times are deliberately absent. A coupon is valid for whole days: from 00:00
 * on `valid_from` to 00:00 the day AFTER `valid_to`, so a request for the 17th
 * to the 18th covers both days completely. `couponWindow` below is the only
 * place that arithmetic lives.
 */
export const CouponRequestDraft = z.object({
  /** Prefilled with the customer's phone; the agent may rewrite it. */
  title: z.string().min(1).max(120),
  /** Generated, not typed — see `generateCouponCode`. */
  code: z.string().min(4).max(40),
  issuing_side: z.string().min(1),
  delivery_type: z.string().min(1),
  coupon_type: z.string().min(1),
  discount_category: z.string().min(1),
  /** `YYYY-MM-DD`. */
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The ceiling on what this coupon can ever be worth, in SAR. */
  max_discount: z.number().nonnegative(),
  /** How many times it may be redeemed. */
  usage_limit: z.number().int().positive(),
  /**
   * Why, carried over from the ticket's description and editable here — the
   * agent who typed the complaint is not always the one raising the coupon.
   */
  compensation_reason: z.string().max(2000),
  /**
   * Resolved from the ticket's order, never chosen in the form: the coupon
   * belongs to the branch the complaint was about, and letting an agent pick
   * would let them compensate against the wrong one.
   */
  brand_id: z.string().nullish(),
  restaurant_id: z.string().nullish(),
});
export type CouponRequestDraft = z.infer<typeof CouponRequestDraft>;

/** `valid_to` cannot precede `valid_from`. */
export const CouponRequestDraftChecked = CouponRequestDraft.refine(
  (v) => v.valid_to >= v.valid_from,
  { path: ['valid_to'], message: 'The end date cannot be before the start date.' },
);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A coupon code a human can read aloud down a phone line.
 *
 * `I`, `O`, `0` and `1` are left out of the alphabet: a customer reading a code
 * back to an agent confuses them, and a compensation coupon is very often read
 * aloud. Uniqueness is the caller's job — generate, check against the store,
 * regenerate on the rare collision.
 */
export function generateCouponCode(
  random: () => number = Math.random,
  prefix = 'SARA',
  length = 8,
): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return `${prefix}-${out}`;
}

/**
 * The instants a coupon is actually live between.
 *
 * Whole days, inclusive of both ends: 17th → 18th means 00:00 on the 17th until
 * 00:00 on the 19th. Returned as ISO strings because that is what the coupon
 * store wants, and computed in UTC so the boundary does not move with whoever
 * happens to be looking at it.
 */
export function couponWindow(validFrom: string, validTo: string): { from: string; to: string } {
  const from = new Date(`${validFrom}T00:00:00.000Z`);
  const end = new Date(`${validTo}T00:00:00.000Z`);
  // One day past the last valid day, so the final day is covered in full.
  end.setUTCDate(end.getUTCDate() + 1);
  return { from: from.toISOString(), to: end.toISOString() };
}

/**
 * The default validity a fresh request opens with: today, for one month.
 *
 * One month rather than 30 days — an agent offering "a month" means the same
 * date next month, and a coupon that expires on the 30th when it was issued on
 * the 31st is a support call. The agent can change both dates.
 */
export function defaultCouponDates(today: Date): { valid_from: string; valid_to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date(today);
  to.setUTCMonth(to.getUTCMonth() + 1);
  return { valid_from: iso(today), valid_to: iso(to) };
}

/**
 * What the ticket records about compensation once the agent has decided.
 *
 * Not shown on the form: it is a consequence of ticking the box, not a separate
 * question, and asking twice invites the two answers to disagree.
 */
export function compensationFlag(assignCoupon: boolean): 'Compensated' | 'Not Compensated' {
  return assignCoupon ? 'Compensated' : 'Not Compensated';
}
