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
  title: z.string().min(1, 'Give the coupon a title — the customer’s phone works.').max(120),
  /** Generated, not typed — see `generateCouponCode`. */
  code: z.string().min(4).max(40),
  issuing_side: z.string().min(1, 'Choose an issuing side.'),
  /**
   * One or more fulfilment channels, stored comma-joined ("Delivery, Pickup").
   * "All" stands for every channel at once, so it never combines with others —
   * see `toggleDeliveryType`.
   */
  delivery_type: z.string().min(1, 'Choose at least one delivery type.'),
  coupon_type: z.string().min(1, 'Choose a coupon type.'),
  discount_category: z.string().min(1, 'Choose a discount category.'),
  /** `YYYY-MM-DD`. */
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The flat amount off, when the category is an amount. */
  coupon_value: z.number().nonnegative('A coupon value cannot be negative.').nullish(),
  /** The percentage off, when the category is a percentage. */
  coupon_percent: z
    .number()
    .min(0, 'A percentage cannot be negative.')
    .max(100, 'A percentage cannot be over 100.')
    .nullish(),
  /** The ceiling on what this coupon can ever be worth, in SAR. */
  max_discount: z.number().nonnegative('A discount cannot be negative.'),
  /** How many times it may be redeemed. */
  usage_limit: z.number().int().positive('It has to be usable at least once.'),
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
  /**
   * The specific order line the compensation is about (e.g. the missing item),
   * chosen from the order's item names. Optional — not every complaint is about
   * one item.
   */
  item_name: z.string().nullish(),
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
export function couponPrefix(issuingSide: string | null | undefined): string {
  const s = (issuingSide ?? '').trim().toLowerCase();
  if (!s) return 'SARA';
  if (s.startsWith('op')) return 'OPS';
  if (s.startsWith('mk') || s.startsWith('mar')) return 'MKT';
  // Anything else is the delivery company itself, so its own name leads: the
  // list is editable, and a new courier should not need a code change.
  return (
    s
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 6)
      .toUpperCase() || 'SARA'
  );
}

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
 * The delivery types a stored value names, e.g. "Delivery, Pickup" → both.
 *
 * The column keeps its comma-joined string shape (older rows hold a single
 * value, and Directus filters on the column as text), so parsing lives here
 * rather than in every reader.
 */
export function parseDeliveryTypes(stored: string | null | undefined): string[] {
  return (stored ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Add or remove one delivery type from a comma-joined selection.
 *
 * "All" means every channel at once, so it is mutually exclusive with the
 * specific types: picking it clears them, and picking a specific type clears
 * it. Order follows the offered list so the stored string is stable.
 */
export function toggleDeliveryType(stored: string, value: string, offered: string[]): string {
  const isAll = (v: string) => v.trim().toLowerCase() === 'all';
  const current = parseDeliveryTypes(stored);
  let next: string[];
  if (current.includes(value)) {
    next = current.filter((v) => v !== value);
  } else if (isAll(value)) {
    next = [value];
  } else {
    next = [...current.filter((v) => !isAll(v)), value];
  }
  const rank = new Map(offered.map((v, i) => [v, i]));
  next.sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999));
  return next.join(', ');
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
