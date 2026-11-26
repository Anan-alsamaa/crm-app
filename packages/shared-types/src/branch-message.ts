/**
 * A CUSTOM MESSAGE TO A BRANCH (owner, 26 Nov 2026).
 *
 * The automatic branch notification is raised by a ticket. This is the other
 * kind: an agent writes to one branch's SaraPOS printer with no ticket at all
 * ("please call WeCare", "the customer is on the way to collect"). It travels
 * the same outbox (`store_notifications`, `kind: 'custom'`) and the same
 * sender, so retries, the stale-row guard, the kept SaraPOS reply and the
 * staging redirect to the lab outlet all apply unchanged.
 *
 * The limits below are enforced by the server (app-roles-sync, which mirrors
 * them - `branch-message.test.ts` fails if they drift); the portal only shows
 * them early.
 */

/** The `kind` a custom message carries. A ticket's notification has none. */
export const BRANCH_MESSAGE_KIND = 'custom';

/** Longest message, in characters. A branch printer is a narrow receipt. */
export const BRANCH_MESSAGE_MAX = 500;

/** Most custom messages one branch receives in an hour, from everyone together. */
export const BRANCH_MESSAGE_PER_HOUR = 5;

/** What the printed heading says before any order number. */
export const BRANCH_MESSAGE_HEADING = 'WeCare message';

/** The heading SaraPOS prints: "WeCare message" or "WeCare message - Order 1350658". */
export function branchMessageHeading(orderId?: string | null): string {
  const order = orderId?.trim();
  return order ? `${BRANCH_MESSAGE_HEADING} - Order ${order}` : BRANCH_MESSAGE_HEADING;
}

/**
 * Does the text look like it carries a customer's phone number? Branch
 * messages never did: the ticket notification sends no customer details, and a
 * message typed by hand must not start. A WARNING in the form, not a refusal -
 * an agent may be giving the branch WeCare's own number.
 *
 * Saudi mobiles in any of the forms people type: 05XXXXXXXX, 5XXXXXXXX,
 * +9665..., 009665..., with spaces or dashes. An order number (7 digits) is not one.
 */
export function looksLikePhoneNumber(text: string): boolean {
  const digits = text.replace(/[\s\-().]/g, '');
  return /(?:^|\D)(?:\+?966|00966|0)?5\d{8}(?:\D|$)/.test(digits);
}

/** Why a message cannot be sent as it stands, or null when it can. */
export function branchMessageProblem(text: string | null | undefined): 'empty' | 'too_long' | null {
  const t = (text ?? '').trim();
  if (!t) return 'empty';
  if (t.length > BRANCH_MESSAGE_MAX) return 'too_long';
  return null;
}
