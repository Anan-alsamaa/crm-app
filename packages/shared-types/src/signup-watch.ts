/**
 * WAITING FOR A CUSTOMER TO JOIN YIJI (owner, 2026-10-07, EMA-49).
 *
 * A coupon for a number with no Yiji account is held in the CRM, and the number
 * is looked up again until it resolves — then the coupon is created and given
 * to the account they just made. Yiji tells nobody when somebody signs up, so
 * asking is the only way to know; this decides HOW OFTEN.
 *
 * Once every five hours until the coupon expires (see signupCheckInterval).
 * Only the numbers still
 * waiting are ever looked up — a handful at a time — never the whole customer
 * base. The owner rejected open-ended polling; this ends with the coupon.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Stop waiting after this long when the coupon itself has no end date. */
export const SIGNUP_WAIT_MAX_MS = 90 * DAY;

/**
 * How long to leave between two lookups: EVERY 5 HOURS, flat (owner,
 * 2026-10-27, after the 2026-10-26 Yiji flood: "one every 5 hours is fine").
 * The old ramp - every 10 minutes on the first day - cost Yiji ~144 lookups a
 * day per held coupon for a signup that rarely comes that fast.
 */
export function signupCheckInterval(_waitedMs: number): number {
  return 5 * HOUR;
}

export type SignupCheck = 'due' | 'wait' | 'expired';

/**
 * Whether a held coupon's number should be looked up now.
 *
 * `expired` once the coupon can no longer be used (its `valid_to` has passed)
 * or it has waited `SIGNUP_WAIT_MAX_MS` with no end date — the caller records
 * that and stops asking.
 */
export function signupCheck(args: {
  awaitingSince: string | Date;
  lastChecked: string | Date | null | undefined;
  validTo: string | Date | null | undefined;
  now?: Date;
}): SignupCheck {
  const now = (args.now ?? new Date()).getTime();
  const since = new Date(args.awaitingSince).getTime();
  if (!Number.isFinite(since)) return 'due';
  const validTo = args.validTo ? new Date(args.validTo).getTime() : NaN;
  if (Number.isFinite(validTo) ? now > validTo : now - since > SIGNUP_WAIT_MAX_MS) {
    return 'expired';
  }
  const last = args.lastChecked ? new Date(args.lastChecked).getTime() : NaN;
  if (!Number.isFinite(last)) return 'due';
  return now - last >= signupCheckInterval(now - since) ? 'due' : 'wait';
}
