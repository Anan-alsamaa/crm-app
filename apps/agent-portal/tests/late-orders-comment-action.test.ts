import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/**
 * THE BUTTON STAYS ON A HANDLED ORDER (ops, 2026-10-04).
 *
 * *"Handled orders should also have the Comment button so the agent can edit
 * the reason and action."*
 *
 * It used to disappear the moment a coupon was given, on the reasoning that the
 * coupon's own reason overrides the comment. In practice the reason and action
 * recorded WITH a coupon are the ones typed in a hurry, and with the button
 * gone there was no way to correct them at all.
 *
 * The guard that makes this safe is `decisionOutcome`, asserted above: a
 * compensated row carries an `editingDecisionId` and still yields `'coupon'`
 * when compensating, and `'update'` when editing text — so the edit rewrites
 * wording and can never un-handle the order. These tests pin the RENDERING,
 * which is the half that was wrong.
 */
const SRC = readFileSync(
  resolve(import.meta.dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
  'utf8',
);

describe('the comments column on a handled order', () => {
  /* THE REGRESSION: a dash instead of a button once handled. */
  it('no longer blanks the cell when the order is handled', () => {
    expect(SRC).not.toMatch(
      /stateOf\(row\.orderId\) === 'handled' \? \(\s*<span className="text-xs text-muted-foreground">—<\/span>/,
    );
  });

  /* The button is now unconditional — the only test left in that cell is which
     WORD it carries. */
  it('offers the button whatever the state', () => {
    const cell = SRC.slice(
      SRC.indexOf("onClick={() => openDecision(row, 'commented', true)}") - 400,
    );
    expect(cell).toContain("openDecision(row, 'commented', true)");
  });

  /* "Comment" on a fresh order, "Edit" once something is recorded — so an agent
     is not left wondering whether they are about to add a second note. */
  it('says Edit rather than Comment once a decision exists', () => {
    expect(SRC).toMatch(/stateOf\(row\.orderId\) === 'pending'/);
    expect(SRC).toMatch(/lateOrders\.editComment/);
  });
});

/**
 * THE FULL REASON AND ACTION ON HOVER (ops, 2026-10-04).
 *
 * Both cells truncated with the rest behind a native `title`, which is
 * invisible on a touch screen, invisible to a keyboard user, and cannot wrap.
 * `LongText` renders the value in a panel on hover AND focus.
 */
describe('reading a long reason', () => {
  it('uses LongText for both columns', () => {
    expect(SRC).toMatch(/<LongText value=\{decisionOf\(row\.orderId\)\?\.reason\} \/>/);
    expect(SRC).toMatch(/<LongText value=\{decisionOf\(row\.orderId\)\?\.action_taken\} \/>/);
  });

  /* THE REGRESSION: the bare `title` tooltip these replace. */
  it('no longer relies on a title attribute alone', () => {
    expect(SRC).not.toMatch(/title=\{decisionOf\(row\.orderId\)\?\.reason \?\? undefined\}/);
  });
});
