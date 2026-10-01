import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A COUPON CAN BE APPROVED WHEN THERE IS *ANY* WAY TO REACH THE CUSTOMER.
 *
 * The bug (owner, 2026-10-01): approving a pending coupon failed outright with
 * "This request has no order, so the coupon cannot be delivered." Three real
 * requests were stuck — OPS-433RHNBB, OPS-ZGTYPVZQ, OPS-A2KK9EL7 — and two of
 * them resolve to real Yiji customers, so they would have been delivered.
 *
 * THIS GUARD HAS NOW BEEN WRONG TWICE, THE SAME WAY: it names one route to the
 * customer and treats it as the only one.
 *
 *   v1 demanded a TICKET. Approving without one skipped the write and marked
 *      the request approved anyway, so the page claimed the coupon was on a
 *      ticket that had nothing on it.
 *   v2 demanded an ORDER, on the premise that the order "is the only thing Yiji
 *      needs to deliver a coupon".
 *
 * That premise is false. `AddCompensationCoupon` grants by `userId` with a
 * NULLABLE `orderId`, and the push worker reaches it by resolving the
 * customer's phone. A WhatsApp compensation has no order and delivers fine.
 *
 * So the rule is: an order OR a phone. Only a request with NEITHER is refused —
 * the one case where approving records a compensation nothing can carry out.
 *
 * Asserted against the SOURCE, like `coupon-decide-invalidates-reports`: the
 * mutation needs a live QueryClient, a Directus transport and a job producer to
 * reach, and mocking all three to observe one throw would be testing the mocks.
 * What matters is that the condition keeps asking the wider question.
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');
const API = read('src/features/coupon-approvals/api.ts');
const PAGE = read('src/features/coupon-approvals/CouponApprovalsPage.tsx');

describe('the approval guard', () => {
  /* THE REGRESSION ITSELF: a bare `if (!couponOrderId(row)) throw` is what
     blocked all three coupons. The order may still be checked — it just cannot
     be the only thing checked. */
  it('does not refuse on the order alone', () => {
    expect(API).not.toMatch(/if \(!couponOrderId\(row\)\) \{\s*throw/);
  });

  it('accepts a phone as a route to the customer', () => {
    /* Both homes of the number: a late-order or WhatsApp compensation has no
       contact row, so its phone is on the request itself. */
    expect(API).toContain('row.customer_phone ?? row.contact?.phone');
  });

  it('still refuses when there is neither an order nor a phone', () => {
    expect(API).toContain('COUPON_APPROVAL_NO_ORDER');
    // The order is still half of the question.
    expect(API).toContain('couponOrderId(row)');
  });

  /*
   * A WITHHELD COUPON IS APPROVABLE WITH NO ROUTE AT ALL.
   *
   * `delivery_excluded` means "record this, do not send it" — the refund
   * customer who will not accept an app coupon. Nothing goes to Yiji, so
   * demanding an order or a phone would block the exact case the checkbox
   * exists to serve. I missed this in the first pass of the fix: the guard
   * asked about reachability without asking whether anything was being sent.
   */
  it('lets a withheld coupon through without an order or a phone', () => {
    expect(API).toContain('row.delivery_excluded === true');
    // And it is the FIRST term, so an excluded row short-circuits the rest.
    expect(API).toMatch(/const reachable =\s*withheld \|\|/);
  });

  /*
   * THE MESSAGE MUST NAME THE REAL PRECONDITION. The old wording sent a
   * supervisor hunting for an order number that is not needed, which is how a
   * blocked approval became "ask the agent which order it is for" on a coupon
   * that only ever needed a phone.
   */
  it('tells the supervisor what is actually missing', () => {
    expect(PAGE).toContain('approveUnreachable');
    expect(PAGE).toMatch(/no order number and no customer phone/i);
  });

  it('no longer claims the order alone is the blocker', () => {
    expect(PAGE).not.toMatch(/Ask the agent which order it is for/);
  });
});
