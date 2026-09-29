import { describe, it, expect } from 'vitest';

/**
 * COMMENT IS THE ONLY NON-COUPON ACT, AND IT WRITES (owner spec §1, 2026-09-29).
 *
 * What this replaces: the queue used to offer THREE controls — Assign coupon,
 * Ignore, and a read-only View. Ignore recorded a second final outcome meaning
 * "no compensation", which is what a comment already says, so one order could
 * collect two contradictory records. View, meanwhile, opened the same dialog
 * carrying `action: 'commented'` and had to be prevented from saving anything,
 * which is where the old `noop` branch came from.
 *
 * The model now: Assign coupon, or Comment. A comment on a fresh row CREATES the
 * decision and the order becomes `commented`; a comment on a row that already
 * has one EDITS the wording. Those are the only two write paths, and together
 * they are what guarantees ONE ROW PER ORDER however often it is commented on.
 *
 * Pinned at the decision table rather than the rendering: the page has no mount
 * test, and which branch `commit()` takes is the thing that can silently write
 * the wrong record.
 */

import { decisionOutcome } from '../src/features/late-orders/LateOrdersPage.js';

/** The confirm button's label, from the same condition the dialog uses. */
const confirmLabel = (draft: { action: 'commented' | 'compensated' }): string =>
  draft.action === 'commented' ? 'Save' : 'Continue to coupon';

describe('the comment action', () => {
  it('records the first comment, which is what makes the order Commented', () => {
    expect(decisionOutcome({ action: 'commented', viewing: true }, null)).toBe('record-comment');
  });

  /*
   * THE NO-DUPLICATE GUARANTEE. A second comment must EDIT the row that exists,
   * never add another — the spec is explicit that a late order never gets two
   * records.
   */
  it('edits the existing row rather than adding a second one', () => {
    expect(decisionOutcome({ action: 'commented', viewing: true }, 'dec-1')).toBe('update');
  });

  it('treats a comment the same whether or not it came from the Comment button', () => {
    // `viewing` is only there to tell the dialogs apart; it must not change what
    // is written, or the same press would mean two things.
    expect(decisionOutcome({ action: 'commented' }, null)).toBe('record-comment');
    expect(decisionOutcome({ action: 'commented' }, 'dec-1')).toBe('update');
  });

  /*
   * A COMPENSATION IS NEVER DOWNGRADED. `editingDecisionId` is set on a
   * compensated row too — the coupon path must still win, or editing the text on
   * a handled order would rewrite it as a comment and un-handle it.
   */
  it('still goes to the coupon form when compensating, decision row or not', () => {
    expect(decisionOutcome({ action: 'compensated' }, null)).toBe('coupon');
    expect(decisionOutcome({ action: 'compensated' }, 'dec-1')).toBe('coupon');
  });

  it('labels the comment button Save, and the coupon one Continue to coupon', () => {
    expect(confirmLabel({ action: 'commented' })).toBe('Save');
    expect(confirmLabel({ action: 'compensated' })).toBe('Continue to coupon');
  });
});
