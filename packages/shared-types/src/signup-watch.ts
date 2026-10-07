/**
 * WAITING FOR A CUSTOMER TO JOIN YIJI (owner, 2026-10-07, EMA-49).
 *
 * A coupon for a number with no Yiji account is held in the CRM, and the number
 * is looked up again until it resolves — then the coupon is created and given
 * to the account they just made. Yiji tells nobody when somebody signs up, so
 * asking is the only way to know; this decides HOW OFTEN.
 *
 * Often at first, rarely later. The customer usually installs the app right
 * after the agent tells them to, so the first day is checked every 10 minutes;
 * after that a signup is less likely by the hour, so the checks thin out to
 * hourly for a week and daily until the coupon expires. Only the numbers still
 * waiting are ever looked up — a handful at a time — never the whole customer
 * base. The owner rejected open-ended polling; this ends with the coupon.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Stop waiting after this long when the coupon itself has no end date. */
export const SIGNUP_WAIT_MAX_MS = 90 * DAY;

/** How long to leave between two lookups, by how long the coupon has waited. */
export function signupCheckInterval(waitedMs: number): number {
  if (waitedMs < DAY) return 10 * MINUTE;
  if (waitedMs < 7 * DAY) return HOUR;
  return DAY;
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
