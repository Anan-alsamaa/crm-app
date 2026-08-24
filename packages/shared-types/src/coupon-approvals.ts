/**
 * Coupons an agent wants to give a customer, and the supervisor who decides.
 *
 * The rule the whole feature rests on: a coupon does NOT reach the ticket until
 * somebody other than the agent has approved it. Writing the coupon first and
 * asking afterwards would make approval a formality applied to money already
 * promised — the customer has been told, and a supervisor saying "no" at that
 * point is a broken promise rather than a control.
 *
 * Pure functions: they decide what a request contains and what an approval
 * writes. They never talk to Directus.
 */

/**
 * DERIVED, not retyped. There is one list of coupon states and this is a view
 * of it.
 *
 * This constant used to be its own hand-written `['pending','approved',
 * 'rejected']` while `CouponRequestStatus` next door carried five values — and
 * the two disagreed about the two that matter most. The worker writes
 * `assigned` the moment Yiji accepts a coupon, and reads `edited` as approved;
 * neither existed here, so the admin console's own type said a state its data
 * would routinely be in was impossible, and `TONE[row.status]` fell through to
 * a default for the one status that means the customer actually has something.
 *
 * The Directus `choices` for this column are generated from the same list, so
 * the three places that have to agree cannot drift apart again.
 */
import { CouponRequestStatus } from './coupon-request.js';

export const COUPON_APPROVAL_STATUSES = CouponRequestStatus.options;
export type CouponApprovalStatus = (typeof COUPON_APPROVAL_STATUSES)[number];

/** The coupon fields as the ticket form holds them (strings from inputs). */
export interface CouponInput {
  coupon_code: string;
  coupon_value: string;
  coupon_percent: string;
  compensation: string;
}

/** What actually gets stored on a ticket once a coupon is approved. */
export interface CouponFields {
  coupon_code: string | null;
  coupon_value: number | null;
  coupon_percent: number | null;
  compensation: string | null;
}

const text = (s: string | null | undefined): string | null => {
  const v = s?.trim();
  return v ? v : null;
};

const num = (s: string | null | undefined): number | null => {
  const v = s?.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Is the agent actually giving something away?
 *
 * A code, an amount or a percentage — any one of them is a coupon. The
 * `compensation` dropdown alone is NOT: "Not Compensated" is a statement that
 * nothing was given, and sending that for approval would bury the real requests
 * under a queue of nothing.
 */
export function isCouponRequested(v: CouponInput): boolean {
  return !!text(v.coupon_code) || num(v.coupon_value) !== null || num(v.coupon_percent) !== null;
}

/**
 * Is what the agent typed a DIFFERENT coupon from the one already on the ticket?
 *
 * The edit form is seeded from the ticket, so an approved coupon is sitting in
 * those inputs every time somebody opens Edit to fix a typo in the resolution
 * notes. Without this check, saving that form raises a fresh approval request
 * for a coupon the supervisor already approved — and withholds `compensation`
 * as though something were pending, wiping a legitimate value off the ticket.
 * The supervisor gets a queue of duplicates and the ticket loses data, for an
 * edit that never touched the coupon.
 *
 * Compared field by field on the parsed values, so "5" and "5.0" are the same
 * coupon and a whitespace change is not a new request.
 */
export function couponDiffers(draft: CouponInput, current: CouponFields): boolean {
  return (
    text(draft.coupon_code) !== (text(current.coupon_code) ?? null) ||
    num(draft.coupon_value) !== current.coupon_value ||
    num(draft.coupon_percent) !== current.coupon_percent
  );
}

/**
 * Split what the agent typed into what the ticket may keep now and what has to
 * wait for a supervisor.
 *
 * Everything about the coupon is withheld — including `compensation`, because a
 * ticket that says "Compensated" with no coupon on it reads as a coupon that
 * was issued and then lost.
 */
export function splitCouponForApproval(v: CouponInput): {
  /** Written to the ticket immediately. */
  ticket: CouponFields;
  /** Null when there is nothing to approve. */
  request: CouponFields | null;
} {
  const held: CouponFields = {
    coupon_code: text(v.coupon_code),
    coupon_value: num(v.coupon_value),
    coupon_percent: num(v.coupon_percent),
    compensation: text(v.compensation),
  };
  if (!isCouponRequested(v)) {
    // No coupon: `compensation` is just a statement of fact and belongs on the
    // ticket straight away.
    return {
      ticket: { ...held, coupon_code: null, coupon_value: null, coupon_percent: null },
      request: null,
    };
  }
  return {
    ticket: { coupon_code: null, coupon_value: null, coupon_percent: null, compensation: null },
    request: held,
  };
}

/** The patch that puts an approved coupon onto its ticket. */
export function approvedCouponPatch(request: CouponFields): CouponFields {
  return {
    coupon_code: request.coupon_code,
    coupon_value: request.coupon_value,
    coupon_percent: request.coupon_percent,
    // An approved coupon IS compensation. Defaulting rather than trusting the
    // dropdown stops an approved coupon sitting on a ticket that still claims
    // the customer got nothing.
    compensation: request.compensation ?? 'Compensated',
  };
}

/** Why a request cannot be submitted, or null when it can. */
export function couponRequestProblem(v: CouponInput): 'none-requested' | 'bad-numbers' | null {
  if (!isCouponRequested(v)) return 'none-requested';
  const value = v.coupon_value.trim();
  const percent = v.coupon_percent.trim();
  const badValue = value !== '' && (num(value) === null || (num(value) as number) < 0);
  const pct = num(percent);
  const badPercent = percent !== '' && (pct === null || pct < 0 || pct > 100);
  return badValue || badPercent ? 'bad-numbers' : null;
}
