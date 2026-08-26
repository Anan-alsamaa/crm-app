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
   *
   * This is the HUMAN label: it is what a supervisor reads on the approval and
   * what an agent typed when there was no order to pick from. It is deliberately
   * not the thing to group or report by — see `item_sku`.
   */
  item_name: z.string().nullish(),
  /**
   * Yiji's item id for the line above, when it was PICKED from a real order.
   *
   * The name cannot be the key. `item_name` already holds `Vegetable Pasta.yy`
   * in this database — one typo, permanently its own distinct value — so
   * "which customers complained about the pasta" splits across spellings and
   * quietly under-reports. An id has no spellings.
   *
   * Null when the agent typed the item by hand (a phoned-in complaint with no
   * order attached). That is honest: there is no id to record, and inventing
   * one from the name would recreate the problem it exists to solve.
   */
  item_sku: z.string().nullish(),
});
export type CouponRequestDraft = z.infer<typeof CouponRequestDraft>;

/** Is this category a percentage discount? The list is editable, the shape is not. */
export function isPercentageCategory(category: string | null | undefined): boolean {
  return (category ?? '').trim().toLowerCase().startsWith('percent');
}

/** The money side of a coupon, as any surface holds it mid-edit. */
export interface CouponTerms {
  discount_category?: string | null;
  /** Absent and zero mean the same thing here: no amount was given. */
  coupon_value?: number | null;
  coupon_percent?: number | null;
  max_discount?: number | null;
}

/** One problem with a coupon's numbers: what is wrong, and which field owns it. */
export interface CouponTermsProblem {
  field: 'coupon_value' | 'coupon_percent' | 'max_discount';
  message: string;
}

/**
 * The rules that make a coupon's numbers mean something.
 *
 * Shared by the agent's request form, the schema below, and the supervisor's
 * amend-and-approve form, because all three write the same two money columns
 * and a rule enforced in only one of them is not a rule. Every clause here
 * exists because the data already went wrong that way:
 *
 *  - An "Amount" coupon with NO amount validated, and one was approved worth
 *    0 SAR. A coupon nobody can spend is not a coupon, the same way a usage
 *    limit of zero is not a coupon.
 *  - An amount of 568 was approved with a 55 cap. Whichever number the customer
 *    was promised, one of the two was a lie. For an amount, the cap IS the
 *    amount, so it can never contradict it.
 *  - A percentage with no cap is an open cheque: 20% of an unbounded order is
 *    an unbounded liability, and the cap is the only thing bounding it.
 */
export function couponTermsProblems(terms: CouponTerms): CouponTermsProblem[] {
  const out: CouponTermsProblem[] = [];
  const pct = isPercentageCategory(terms.discount_category);
  const value = terms.coupon_value ?? null;
  const percent = terms.coupon_percent ?? null;
  const cap = terms.max_discount ?? null;

  if (pct) {
    if (percent === null || !(percent > 0)) {
      out.push({
        field: 'coupon_percent',
        message: 'Enter the percentage that comes off — a 0% coupon is worth nothing.',
      });
    }
    if (cap === null || !(cap > 0)) {
      // Not a style preference: without a ceiling, the payout is whatever the
      // order happened to be worth.
      out.push({
        field: 'max_discount',
        message: 'A percentage coupon needs a maximum discount, or it has no ceiling.',
      });
    }
  } else {
    if (value === null || !(value > 0)) {
      out.push({
        field: 'coupon_value',
        message: 'Enter the amount that comes off — a coupon worth 0 is not a coupon.',
      });
    }
    if (value !== null && cap !== null && cap > 0 && cap < value) {
      out.push({
        field: 'max_discount',
        message: 'The maximum discount is below the coupon value, so one of the two is wrong.',
      });
    }
  }
  return out;
}

/**
 * The most this coupon can ever cost, in SAR.
 *
 * For a flat amount that is the amount. For a percentage it is the CAP, not the
 * percentage — 20% is not a number of riyals, and the cap is the only bound on
 * what a percentage actually pays out (see `couponTermsProblems`, which refuses
 * a percentage with no cap for exactly this reason).
 *
 * Returns 0 when neither is set rather than guessing, so a half-filled draft
 * cannot trip an alert while the agent is still typing.
 */
export function couponExposure(terms: CouponTerms): number {
  const cap = terms.max_discount ?? 0;
  if (isPercentageCategory(terms.discount_category)) return cap > 0 ? cap : 0;
  const value = terms.coupon_value ?? 0;
  return Math.max(value, cap > 0 ? cap : 0);
}

/**
 * Above this, in SAR, a coupon is worth an admin's attention on its own.
 *
 * This is NOT the approval threshold — every coupon already needs a supervisor,
 * and that queue is a work list someone opens when they get to it. This is the
 * separate question of whether a single coupon is large enough that nobody
 * should have to be looking at the right screen to find out about it.
 */
export const COUPON_ALERT_THRESHOLD_SAR = 200;

/** Whether this coupon is large enough to raise an admin alert on its own. */
export function isHighValueCoupon(terms: CouponTerms): boolean {
  return couponExposure(terms) > COUPON_ALERT_THRESHOLD_SAR;
}

/**
 * `valid_to` cannot precede `valid_from`, and the numbers have to add up —
 * see `couponTermsProblems` for why each of those clauses exists.
 */
export const CouponRequestDraftChecked = CouponRequestDraft.superRefine((v, ctx) => {
  if (v.valid_to < v.valid_from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valid_to'],
      message: 'The end date cannot be before the start date.',
    });
  }
  for (const p of couponTermsProblems(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p.field], message: p.message });
  }
});

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A coupon code a human can read aloud down a phone line.
 *
 * `I`, `O`, `0` and `1` are left out of the alphabet: a customer reading a code
 * back to an agent confuses them, and a compensation coupon is very often read
 * aloud. Uniqueness is the caller's job — generate, check against the store,
 * regenerate on the rare collision.
 */
/**
 * WHO ISSUED A COUPON — the CRM word, its code prefix, and Yiji's id.
 *
 * One table because these three must never disagree: the prefix is what an
 * agent reads down a phone line, and `yijiId` is what attributes the cost to a
 * department in Yiji's own reporting. Deriving them in two places is how a
 * coupon ends up prefixed CC and booked to Operations.
 *
 * ⚠ `yijiId` IS NOT CONFIRMED for any row. The only id ever observed is 6, on
 * a coupon of unknown issuing side (70644). Every value below is null, and a
 * null is NOT SENT — Yiji then applies its own default, exactly as today.
 * That is deliberate: a wrong id does not fail loudly, it silently books real
 * money to the wrong department in the reports the owner reads, and stays
 * wrong for ever. Fill these in the moment Yiji supplies the list; nothing
 * else needs to change.
 *
 * The delivery companies are named individually rather than a single
 * "Delivery", because a coupon issued because Shadh lost the order is not the
 * same cost centre as one issued because Taker did.
 */
export interface IssuingSide {
  /** The word in `option_lists`, exactly as operations typed it. */
  value: string;
  /** Leads the coupon code. Short, and unambiguous read aloud. */
  prefix: string;
  /** Yiji's `issuingSideId`. Null = unknown, and therefore not sent. */
  yijiId: number | null;
}

export const ISSUING_SIDES: readonly IssuingSide[] = [
  { value: 'Customer Care', prefix: 'CC', yijiId: null },
  { value: 'Operations', prefix: 'OPS', yijiId: null },
  { value: 'Marketing', prefix: 'MKT', yijiId: null },
  /*
   * The delivery companies carry their FULL NAME, by the owner's decision.
   *
   * The three above are internal departments and abbreviate naturally — an
   * agent knows OPS is Operations. A courier is an outside company being
   * charged for the coupon, and the name is the point: "SHUROUQ-9U7KNSDF"
   * says who is paying to anyone reading it, on an invoice or down a phone,
   * without a lookup table only this team has. Length is the smaller cost.
   *
   * (I shortened these to SHD/TKR/SHQ/LJK/PRC for visual consistency with the
   * departments; the owner reversed it. Consistency of SHAPE was the wrong
   * thing to optimise for against being able to read who owes the money.)
   */
  { value: 'Shadh', prefix: 'SHADH', yijiId: null },
  { value: 'Taker', prefix: 'TAKER', yijiId: null },
  { value: 'Shurouq', prefix: 'SHUROUQ', yijiId: null },
  { value: 'Leajlak', prefix: 'LEAJLAK', yijiId: null },
  { value: 'Parcel', prefix: 'PARCEL', yijiId: null },
];

/**
 * Find an issuing side by its CRM word.
 *
 * Matched case- and punctuation-insensitively because `option_lists` is edited
 * by hand: "Customer care", "customer-care" and "Customer Care" are the same
 * department, and a coupon must not be prefixed differently for a stray capital.
 * Also accepts the historical spellings ("Call Centre", "Delivery") so coupons
 * raised before the list was renamed still resolve.
 */
export function findIssuingSide(word: string | null | undefined): IssuingSide | undefined {
  const key = (word ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!key) return undefined;
  const ALIASES: Record<string, string> = {
    // Renamed 2026-08-26; rows written before that still say these.
    callcentre: 'Customer Care',
    callcenter: 'Customer Care',
    cc: 'Customer Care',
    customercare: 'Customer Care',
  };
  const target = (ALIASES[key] ?? word ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return ISSUING_SIDES.find((s) => s.value.toLowerCase().replace(/[^a-z0-9]+/g, '') === target);
}

/** Yiji's `issuingSideId` for a CRM issuing side, or undefined when unknown. */
export function yijiIssuingSideId(word: string | null | undefined): number | undefined {
  return findIssuingSide(word)?.yijiId ?? undefined;
}

export function couponPrefix(issuingSide: string | null | undefined): string {
  // The table first, so a prefix and a Yiji id can never come from different
  // rules — see ISSUING_SIDES.
  const known = findIssuingSide(issuingSide);
  if (known) return known.prefix;

  const s = (issuingSide ?? '').trim().toLowerCase();
  if (!s) return 'SARA';
  /*
   * A side nobody has coded for yet: derive from its own name.
   *
   * `option_lists` is operations-editable, so a new courier must not need a
   * deploy to issue coupons. Twelve characters, because an unlisted side is
   * most likely a new DELIVERY COMPANY and those carry their full name — six
   * would have cut "SHUROUQ" to "SHUROU", which is neither the name nor a code.
   */
  return (
    s
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 12)
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

/*
 * ───────────────────────────────────────────────────────────────────────────
 * HOW YIJI ENCODES A COUPON
 *
 * The CRM stores these as the words operations edits in `option_lists`; Yiji
 * stores them as integers. Until 2026-08-26 the push sent NONE of them, so
 * every coupon we created inherited Yiji's defaults — a coupon the CRM called
 * Private/Amount/All/Water arrived as General/Percentage/none/none. The money
 * was right (`discount` and `maximumDiscount` were always sent); everything
 * describing WHAT KIND of coupon it was, was not.
 *
 * The two mappings below are read off real coupons, not guessed:
 *   70640 — ours, sent without these fields: type 0, category 0
 *           and Yiji's console showed it as General / Percentage.
 *   70644 — created correctly inside Yiji as Private / Amount:
 *           type 1, category 1.
 * ───────────────────────────────────────────────────────────────────────────
 */

/**
 * Yiji's `deliveryTypes`: which channels a coupon may be redeemed through.
 *
 * ⚠ THE NUMBERING IS THE ONE THING HERE THAT IS NOT PROVEN. Everything else in
 * this file was read off real coupons; this was not, and it is the reason
 * `deliveryTypes` went unsent for so long.
 *
 * What IS known: Yiji's own correctly-built coupon 70644 carries `[3,1,2]` —
 * three values, and no 0. Their ORDER api uses a 0-based vocabulary
 * (0=delivery, 1=pickup, 2=carhop, 3=in_restaurant — verified independently:
 * order 1234535 is deliveryType 2 and renders as Carhop). Under that map
 * `[3,1,2]` would mean "everything except delivery", which is a strange thing
 * for a general coupon to be — so the coupon vocabulary is most likely 1-BASED
 * with 0 meaning unset, which is what the absence of 0 suggests.
 *
 * The table below encodes that reading. If Yiji confirms different numbers,
 * THIS IS THE ONLY PLACE TO CHANGE — the payload builder and the console both
 * go through it.
 *
 * Getting it wrong is not cosmetic: a coupon restricted to channels the
 * customer cannot order through is a coupon that silently never works. That is
 * why an unmapped word is dropped rather than guessed at, and why "All" sends
 * NOTHING — an empty list is how Yiji already spells "no restriction", so the
 * unrestricted case needs no numbering to be correct.
 */
export const YIJI_DELIVERY_TYPE_CODE: Record<string, number> = {
  delivery: 1,
  pickup: 2,
  carhop: 3,
  'drive thru': 3,
  'drive-thru': 3,
  takeout: 4,
  takeaway: 4,
  'dine-in': 5,
  'dine in': 5,
  dinning: 5,
  dining: 5,
};

/**
 * The `deliveryTypes` array for a stored CRM selection.
 *
 * Returns null — meaning "send no `deliveryTypes` at all" — for the two cases
 * where an array would be wrong rather than merely empty:
 *   - "All", because an empty list is Yiji's own spelling of unrestricted, and
 *     enumerating every channel would break the moment they add one.
 *   - nothing recognised, because a partial list silently REMOVES the channels
 *     it failed to map.
 */
export function yijiDeliveryTypes(stored: string | null | undefined): number[] | null {
  const picked = parseDeliveryTypes(stored);
  if (picked.length === 0) return null;
  if (picked.some((p) => p.trim().toLowerCase() === 'all')) return null;

  const codes: number[] = [];
  for (const p of picked) {
    const code = YIJI_DELIVERY_TYPE_CODE[p.trim().toLowerCase()];
    // One unrecognised channel invalidates the whole list: sending the rest
    // would quietly narrow the coupon to fewer channels than were approved.
    if (code == null) return null;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes.length > 0 ? codes : null;
}

/**
 * The order-value ceiling Yiji applies to a coupon.
 *
 * THIS IS WHY A COUPON ARRIVED AS A NOTIFICATION AND THEN WAS NOT IN THE APP.
 *
 * `orderMaximum` is the largest order the coupon may be applied to, and Yiji
 * defaults it to 0 when it is not sent — which is a ceiling of ZERO, so the
 * coupon can never apply to anything. The row is created, the customer is
 * notified, and the coupon is unusable. Their own working coupon (70644)
 * carries 10000; ours (70640) carried 0, and that was the only term differing
 * in a way that could nullify it.
 *
 * Note the asymmetry that makes this easy to get wrong: 0 is PERMISSIVE on a
 * floor (`orderMinimum: 0` = no minimum spend, `limitForUser: 0` = no per-user
 * cap) and RESTRICTIVE on a ceiling. Same number, opposite meaning, depending
 * on which end of the range it bounds.
 *
 * 10000 is Yiji's own "no practical ceiling" sentinel rather than a considered
 * business number — it is what a coupon built in their console gets. Matching
 * a known-working coupon is a smaller leap than keeping a value we have
 * evidence is broken, but it IS matched rather than derived, so it lives here
 * as one named constant.
 */
export const YIJI_ORDER_MAXIMUM = 10000;

/** Yiji's `type`: what audience the coupon is for. */
export const YIJI_COUPON_TYPE: Record<string, number> = {
  general: 0,
  public: 0,
  private: 1,
};

/** Yiji's `category`: how the discount is computed. */
export const YIJI_COUPON_CATEGORY: Record<string, number> = {
  percentage: 0,
  percent: 0,
  amount: 1,
};

/**
 * Map a CRM option-list word onto a Yiji integer.
 *
 * Returns undefined for anything not in the table rather than defaulting to 0 —
 * 0 is a MEANINGFUL value in both maps (General, Percentage), so guessing it
 * would silently create exactly the wrong coupon. An unmapped word is better
 * left for Yiji to default, and is logged by the caller.
 */
export function yijiCouponEnum(
  table: Record<string, number>,
  word: string | null | undefined,
): number | undefined {
  const key = (word ?? '').trim().toLowerCase();
  return key ? table[key] : undefined;
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
  /*
   * LOCAL WALL-CLOCK, no `Z` — matching the format Yiji's own coupons carry.
   *
   * This used to return `toISOString()`, so every date went out as UTC with a
   * `Z`. Their working coupon (70644) carries `2026-08-26T00:00:00` with no
   * timezone marker at all: these are local times, and Saudi is UTC+3. A
   * consumer that parses our string as local reads 00:00 correctly; one that
   * honours the Z reads 03:00 local. Either is survivable at the START of a
   * window, but the same three-hour shift at the END silently expires a coupon
   * on its last day — the sort of thing that looks like "the coupon just
   * disappeared".
   *
   * Sending exactly what they send removes the question. The window is still
   * whole days, inclusive of both ends, and the end is 23:59:00 on the last
   * valid day rather than 00:00 on the day after — again theirs, and it cannot
   * be read as belonging to the following day.
   */
  const pad = (n: number) => String(n).padStart(2, '0');
  // Parsed as UTC deliberately: the input is a plain `YYYY-MM-DD` with no zone,
  // and reading it as UTC keeps the arithmetic free of the running machine's
  // offset. Only the FORMATTING below is local-shaped.
  const end = new Date(`${validTo}T00:00:00.000Z`);
  const day = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;
  return { from: `${validFrom}T00:00:00`, to: `${day}T23:59:00` };
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
