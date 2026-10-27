/**
 * EDITING AN APPROVED COUPON (owner, 2026-10-27).
 *
 * A supervisor / WeCare Admin / the Administrator (`edit_approved_coupons`)
 * may change a coupon that is already approved - even one already sitting in
 * the customer's Yiji wallet. No second approval: it applies at once.
 *
 * It is a REPLACEMENT, never an in-place edit. Yiji keys a coupon by its code
 * and the CRM keys delivery by the grant receipt, so changing the terms of a
 * delivered row would leave the customer holding the OLD coupon while every
 * screen showed the new one. Instead:
 *
 *   1. the editor's portal creates a NEW approved row with the edited terms
 *      and a fresh code (`replaces` -> the old row) - a person's decision,
 *      written with that person's token, like every other approval;
 *   2. the gateway (`/jobs/coupon-replace`, privilege-checked) hands the pair
 *      to the workers, who check the customer has not already USED the old
 *      coupon, mark the old row `replaced_by` -> new, take the old one off the
 *      customer's app (the EMA-80 removal, admin token) and only THEN release
 *      the new one for delivery;
 *   3. anything that goes wrong before the old coupon is gone rolls the new
 *      row back to `rejected` (with the reason) and clears `replaced_by`, so
 *      the customer is never left holding both - or neither.
 *
 * The old row is KEPT (history); it carries `replaced_by` and stops counting
 * in every compensation total. An abandoned replacement (rolled back) is a
 * `rejected` row with `replaces` set and stops counting too.
 *
 * Pure functions only: they never talk to Directus or Yiji.
 */
import { couponDecision, couponTermsProblems, type CouponTerms } from './coupon-request.js';

/**
 * The new columns on `coupon_approvals`. They need a manual `apply:fields`
 * per environment; every reader that names them does so in its OWN
 * best-effort query, because naming a missing field 403s the whole read.
 */
export const COUPON_REPLACE_FIELDS = ['replaces', 'replaced_by', 'replace_reason'] as const;

/** A Directus M2O as it may come back: an id, an expanded object, or nothing. */
export type RelationRef = string | number | { id?: string | number | null } | null | undefined;

/** The id behind an M2O value, or null. */
export function refId(v: RelationRef): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const id = v.id;
    return id === null || id === undefined || String(id).trim() === '' ? null : String(id).trim();
  }
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Must this row be left OUT of compensation totals?
 *
 *  - an OLD coupon an edit replaced (`replaced_by` set) - the replacement is
 *    the coupon that counts; counting both would double the money;
 *  - an edit that was ABANDONED (`replaces` set and `rejected`) - it never
 *    took effect, and it is not a supervisor turning a request down either.
 */
export function couponIsSuperseded(row: {
  status?: string | null;
  replaced_by?: RelationRef;
  replaces?: RelationRef;
}): boolean {
  if (refId(row.replaced_by)) return true;
  return !!refId(row.replaces) && couponDecision(row.status) === 'rejected';
}

/** Why an approved coupon cannot be edited right now, or null when it can. */
export type CouponEditBlock =
  /** Not an approval (pending is still edited from the queue; rejected is closed). */
  | 'not-approved'
  /** Already replaced by an earlier edit - edit the replacement instead. */
  | 'replaced'
  /** Taken back off the ticket (EMA-80). */
  | 'removed'
  /** A removal is still running. */
  | 'removal-pending'
  /** The customer already spent it on an order: it cannot be pulled back. */
  | 'used';

export function couponEditBlock(row: {
  status?: string | null;
  removal_status?: string | null;
  replaced_by?: RelationRef;
}): CouponEditBlock | null {
  if (couponDecision(row.status) !== 'approved') return 'not-approved';
  if (refId(row.replaced_by)) return 'replaced';
  switch (row.removal_status) {
    case 'removed':
    case 'not_on_yiji':
      return 'removed';
    case 'pending':
      return 'removal-pending';
    case 'used':
      return 'used';
    default:
      return null;
  }
}

/**
 * Has this coupon's validity run out? Whole days, inclusive (see
 * `couponWindow`): a coupon valid to the 27th is still good on the 27th.
 * An expired coupon has already left the customer's wallet, so editing it
 * creates a fresh, valid one - allowed, and the form says so.
 */
export function couponIsExpired(validTo: string | null | undefined, today: Date): boolean {
  const end = (validTo ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  return end < today.toISOString().slice(0, 10);
}

/** The edited terms, as both portals' forms hand them over. */
export interface CouponReplacementTerms extends CouponTerms {
  title: string;
  issuing_side: string;
  delivery_type: string;
  coupon_type: string;
  discount_category: string;
  valid_from: string;
  valid_to: string;
  usage_limit: number;
  item_name?: string | null;
  item_sku?: string | null;
  no_other_discounts?: boolean | null;
  /** The coupon's description ("why"), the `reason` column. */
  reason?: string | null;
}

/**
 * The first thing wrong with the edited terms, in words, or null. The same
 * rules a new request and a supervisor's amendment must pass - an edit must not
 * be a way to grant terms that could never have been approved.
 */
export function replacementTermsProblem(
  terms: CouponReplacementTerms,
  today: Date = new Date(),
): string | null {
  for (const [k, label] of [
    ['title', 'Give the coupon a title.'],
    ['issuing_side', 'Choose an issuing side.'],
    ['delivery_type', 'Choose at least one delivery type.'],
    ['coupon_type', 'Choose a coupon type.'],
    ['discount_category', 'Choose a discount category.'],
  ] as const) {
    if (!String(terms[k] ?? '').trim()) return label;
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(terms.valid_from ?? '') || !iso.test(terms.valid_to ?? '')) {
    return 'Give the coupon a start and an end date.';
  }
  if (terms.valid_to < terms.valid_from) return 'The end date cannot be before the start date.';
  if (couponIsExpired(terms.valid_to, today)) {
    return 'The new end date is already past - the customer could never use it.';
  }
  if (!Number.isInteger(terms.usage_limit) || terms.usage_limit < 1) {
    return 'It has to be usable at least once.';
  }
  return couponTermsProblems(terms)[0]?.message ?? null;
}

/** The old row, as much of it as the replacement copies. */
export interface ReplaceableCoupon {
  id: string;
  coupon_code?: string | null;
  ticket?: RelationRef;
  contact?: RelationRef;
  requested_by?: RelationRef;
  vendor?: RelationRef;
  customer_phone?: string | null;
  order_id?: string | null;
  brand_id?: string | null;
  restaurant_id?: string | null;
  compensation?: string | null;
  delivery_excluded?: boolean | null;
  delivery_excluded_reason?: string | null;
}

/**
 * The row the editor's portal creates: the edited terms, a fresh code, and
 * everything about WHO and WHAT FOR copied from the coupon it replaces - same
 * ticket, customer, vendor, order and requesting agent, so every report keeps
 * attributing it to the same complaint.
 *
 * Approved straight away (owner: no second approval), stamped as an
 * amendment by the editor. It is NOT delivered until the workers have taken
 * the old coupon back: the push refuses a row whose `replaces` is not yet
 * settled (`replacementReleased`).
 */
export function buildReplacementCoupon(
  old: ReplaceableCoupon,
  terms: CouponReplacementTerms,
  ctx: { id: string; code: string; editorId: string | null; reason: string; now: Date },
): Record<string, unknown> {
  const pct = (terms.discount_category ?? '').trim().toLowerCase().startsWith('percent');
  const why = ctx.reason.trim();
  return {
    id: ctx.id,
    coupon_code: ctx.code,
    status: 'approved',
    edited_by_admin: true,
    decided_by: ctx.editorId,
    decided_at: ctx.now.toISOString(),
    decision_note: `Edited after approval - replaces ${old.coupon_code ?? 'the earlier coupon'}: ${why}`,
    replaces: old.id,
    replace_reason: why,
    // WHO and WHAT FOR - unchanged by an edit.
    ticket: refId(old.ticket),
    contact: refId(old.contact),
    requested_by: refId(old.requested_by),
    vendor: refId(old.vendor),
    customer_phone: old.customer_phone ?? null,
    order_id: old.order_id ?? null,
    brand_id: old.brand_id ?? null,
    restaurant_id: old.restaurant_id ?? null,
    compensation: old.compensation ?? 'Compensated',
    delivery_excluded: old.delivery_excluded === true,
    delivery_excluded_reason: old.delivery_excluded_reason ?? null,
    // The edited TERMS.
    title: terms.title.trim(),
    issuing_side: terms.issuing_side.trim(),
    delivery_type: terms.delivery_type.trim(),
    coupon_type: terms.coupon_type.trim(),
    discount_category: terms.discount_category.trim(),
    valid_from: terms.valid_from,
    valid_to: terms.valid_to,
    // Only ONE money column is ever set, by the category.
    coupon_value: pct ? null : (terms.coupon_value ?? null),
    coupon_percent: pct ? (terms.coupon_percent ?? null) : null,
    // For an amount the ceiling IS the amount (OPS-SGVAVXW6).
    max_discount: pct ? (terms.max_discount ?? null) : (terms.coupon_value ?? null),
    usage_limit: terms.usage_limit,
    item_name: terms.item_name?.trim() || null,
    item_sku: terms.item_sku?.trim() || null,
    no_other_discounts: terms.no_other_discounts === true,
    reason: terms.reason ?? null,
  };
}

/**
 * May the replacement be DELIVERED yet? Only once the workers have claimed the
 * old row for it (`replaced_by` = this id) AND the old coupon is gone from the
 * customer's app (removed / never reached it). Until then a sweep or a stray
 * Retry must not put a second coupon in the customer's wallet.
 */
export function replacementReleased(
  replacementId: string,
  old: { replaced_by?: RelationRef; removal_status?: string | null } | null,
): boolean {
  if (!old) return false;
  return (
    refId(old.replaced_by) === replacementId &&
    (old.removal_status === 'removed' || old.removal_status === 'not_on_yiji')
  );
}

/** The ticket history line (a `commented` event, like the coupon request's). */
export function couponReplacedHistoryText(args: {
  oldCode: string | null | undefined;
  newCode: string | null | undefined;
  editor: string | null | undefined;
  reason: string;
}): string {
  return `Coupon ${args.oldCode ?? '—'} replaced by ${args.newCode ?? '—'} by ${
    args.editor?.trim() || 'a supervisor'
  }: ${args.reason.trim()}`;
}

/**
 * Where an edit has got to, read from the two rows (the portal polls them -
 * no Redis, no Yiji): `done` once the old row is claimed AND gone from the
 * app, `refused` once the new row was rolled back (its note says why).
 */
export type CouponReplaceState = 'working' | 'done' | 'refused';
export function couponReplaceState(
  replacement: { id: string; status?: string | null } | null,
  old: { replaced_by?: RelationRef; removal_status?: string | null } | null,
): CouponReplaceState {
  if (replacement && couponDecision(replacement.status) === 'rejected') return 'refused';
  if (replacement && replacementReleased(replacement.id, old)) return 'done';
  return 'working';
}

/* ── The portal side, framework-free (both portals inject their own I/O) ── */

/** What a portal must provide to start an edit. No Yiji anywhere in here. */
export interface CouponReplaceIO {
  /** Is this code already on another coupon row? (one Directus read) */
  codeTaken(code: string): Promise<boolean>;
  /** Create the replacement row with the EDITOR's token. */
  create(row: Record<string, unknown>): Promise<unknown>;
  /** Hand the pair to the workers (gateway `/jobs/coupon-replace`). */
  enqueue(input: {
    couponApprovalId: string;
    replacementId: string;
    reason: string;
  }): Promise<unknown>;
  /** Mark the replacement abandoned when the hand-off failed. */
  abandon(replacementId: string, note: string): Promise<unknown>;
  /** A fresh row id (uuid), minted here so a lost response cannot duplicate it. */
  newId(): string;
  /** A fresh code for this issuing side (`generateCouponCode` + `couponPrefix`). */
  newCode(issuingSide: string): string;
}

/** Thrown when the edit could not even be started; the message says why. */
export class CouponReplaceNotStarted extends Error {
  constructor(
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'CouponReplaceNotStarted';
  }
}

/**
 * Start an edit: a unique fresh code, the replacement row, the hand-off.
 * If the hand-off fails the replacement is abandoned at once (rejected, with
 * the reason), so nothing half-made counts or waits.
 */
export async function startCouponReplacement(
  io: CouponReplaceIO,
  args: {
    old: ReplaceableCoupon;
    terms: CouponReplacementTerms;
    editorId: string | null;
    reason: string;
    now?: Date;
  },
): Promise<{ replacementId: string; code: string }> {
  const reason = args.reason.trim();
  if (!reason) throw new CouponReplaceNotStarted('Give a reason for the change first.');
  const problem = replacementTermsProblem(args.terms, args.now ?? new Date());
  if (problem) throw new CouponReplaceNotStarted(problem);

  let code = '';
  for (let i = 0; i < 6 && !code; i++) {
    const candidate = io.newCode(args.terms.issuing_side);
    if (!(await io.codeTaken(candidate))) code = candidate;
  }
  if (!code) throw new CouponReplaceNotStarted('Could not find a free coupon code - try again.');

  const replacementId = io.newId();
  try {
    await io.create(
      buildReplacementCoupon(args.old, args.terms, {
        id: replacementId,
        code,
        editorId: args.editorId,
        reason,
        now: args.now ?? new Date(),
      }),
    );
  } catch (err) {
    throw new CouponReplaceNotStarted('Could not save the edited coupon.', err);
  }
  try {
    await io.enqueue({ couponApprovalId: args.old.id, replacementId, reason });
  } catch (err) {
    await io
      .abandon(
        replacementId,
        'Not changed: the edit could not be handed to the server, so the original coupon was kept.',
      )
      .catch(() => undefined);
    throw new CouponReplaceNotStarted(
      'The edit could not be started, so the original coupon was kept. Try again.',
      err,
    );
  }
  return { replacementId, code };
}

/**
 * Wait (bounded) for the workers to settle an edit, reading the two ROWS - not
 * Redis, not Yiji. `working` after the timeout means "still going": the cards
 * keep showing the state, nothing is lost.
 */
export async function waitForCouponReplacement(
  read: () => Promise<{
    replacement: { id: string; status?: string | null; decision_note?: string | null } | null;
    old: { replaced_by?: RelationRef; removal_status?: string | null } | null;
  }>,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ state: CouponReplaceState; note: string | null }> {
  const interval = opts.intervalMs ?? 2_000;
  const timeout = opts.timeoutMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; ; waited += interval) {
    try {
      const { replacement, old } = await read();
      const state = couponReplaceState(replacement, old);
      if (state !== 'working') return { state, note: replacement?.decision_note ?? null };
    } catch {
      /* a blip: keep waiting */
    }
    if (waited >= timeout) return { state: 'working', note: null };
    await sleep(interval);
  }
}
