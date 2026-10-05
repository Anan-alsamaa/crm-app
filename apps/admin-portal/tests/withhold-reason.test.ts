import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A WITHHELD COUPON MUST SAY WHY.
 *
 * A coupon can be approved and deliberately NOT sent to the customer's app —
 * the refund case: they want their money back rather than credit, so the coupon
 * is recorded against the ticket and never pushed to Yiji.
 *
 * The `delivery_excluded_reason` column existed, and the card could DISPLAY a
 * reason. Nothing ever wrote one: **there was no input.** Measured on
 * production 2026-10-05 — all 4 withheld coupons carry a blank reason.
 *
 * That is money held back from a customer with nothing on record saying why,
 * and the person who decided is not the person who answers for it three weeks
 * later. Found by sweeping production, not reported.
 */
const SRC = readFileSync(
  resolve(import.meta.dirname, '../src/features/coupon-approvals/CouponApprovalsPage.tsx'),
  'utf8',
);

describe('recording why a coupon was withheld', () => {
  /* THE FIX: an input, not only a readout. */
  it('offers an input whenever the coupon is withheld', () => {
    expect(SRC).toMatch(/\{row\.delivery_excluded && \(\s*<label/);
    expect(SRC).toMatch(/value=\{withholdReason\}/);
    expect(SRC).toContain('couponApprovals.withholdReasonLabel');
  });

  /* THE REGRESSION: display-only, gated on a value nothing could write. */
  it('no longer renders the reason as a read-only line', () => {
    expect(SRC).not.toMatch(
      /row\.delivery_excluded && row\.delivery_excluded_reason\?\.trim\(\) && \(/,
    );
  });

  /*
   * COMMITTED ON BLUR, not per keystroke. This card writes straight through —
   * there is no draft-and-save — so a mutation per character would be a write
   * storm on a money record.
   */
  it('saves on blur rather than on every keystroke', () => {
    expect(SRC).toMatch(/onBlur=\{\(\) => \{/);
    expect(SRC).toMatch(/onChange=\{\(e\) => setWithholdReason\(e\.target\.value\)\}/);
  });

  /* An unchanged value writes nothing: re-focusing and leaving a field must not
     log an edit to a coupon nobody touched. */
  it('does not save an unchanged value', () => {
    expect(SRC).toMatch(
      /if \(next === \(row\.delivery_excluded_reason \?\? ''\)\.trim\(\)\) return;/,
    );
  });

  /* Blank clears it rather than storing an empty string, so "no reason" is one
     value in the database and not two. */
  it('clears the column when the box is emptied', () => {
    expect(SRC).toMatch(/delivery_excluded_reason: next \|\| null/);
  });

  /*
   * AND THE LOCAL DRAFT FOLLOWS THE SERVER. Unchecking the box clears the
   * stored reason; without this the old text would stay in the input, and
   * re-checking would show a reason that is no longer recorded anywhere.
   */
  it('clears the draft when the coupon stops being withheld', () => {
    expect(SRC).toMatch(/if \(!e\.target\.checked\) setWithholdReason\(''\)/);
  });

  /* Seeded from the row, so a reason saved earlier is there to edit rather than
     appearing blank. */
  it('seeds from the stored value', () => {
    expect(SRC).toMatch(/useState\(row\.delivery_excluded_reason \?\? ''\)/);
  });
});
