import { describe, it, expect } from 'vitest';

/**
 * VIEW IS NOT A DECISION.
 *
 * The Notes button was renamed from "Comments" to "View" (owner, 2026-09-28),
 * and its dialog's confirm button must read "Save", not "Ignore".
 *
 * That was not only a label. View and Ignore both open the same box carrying
 * `action: 'ignored'`, and the label/title/field logic keyed on
 * `editingDecisionId` — which is NULL on a row that has no decision yet. So on
 * an undecided row the box said "Ignore this order?" with an "Ignore" button,
 * and pressing it would have RECORDED AN IGNORE and dropped the order off the
 * live queue. The button would have said Save and done the opposite.
 *
 * These pin the decision table rather than the rendering: the page has no mount
 * test, and what matters is which of the four states each combination lands in.
 */

import { decisionOutcome, isNotesView } from '../src/features/late-orders/LateOrdersPage.js';

/** The confirm button's label, from the same predicate the dialog uses. */
const confirmLabel = (
  draft: { action: 'ignored' | 'compensated'; viewing?: boolean },
  editingDecisionId: string | null,
): string =>
  isNotesView(draft, editingDecisionId)
    ? 'Save'
    : draft.action === 'ignored'
      ? 'Ignore'
      : 'Continue to coupon';

const commitBranch = decisionOutcome;

describe('View opens the notes, and never decides', () => {
  it('says Save on an UNDECIDED row — the case that used to say Ignore', () => {
    expect(confirmLabel({ action: 'ignored', viewing: true }, null)).toBe('Save');
  });

  it('says Save on a row that already has a decision', () => {
    expect(confirmLabel({ action: 'ignored', viewing: true }, 'dec-1')).toBe('Save');
  });

  /* The real Ignore button must be untouched: it still decides, and still says
     so. If this ever reads "Save", the rename has swallowed a real action. */
  it('still says Ignore when Ignore was actually pressed', () => {
    expect(confirmLabel({ action: 'ignored' }, null)).toBe('Ignore');
  });

  it('still says Continue to coupon when compensating', () => {
    expect(confirmLabel({ action: 'compensated' }, null)).toBe('Continue to coupon');
  });

  /*
   * THE DANGEROUS ONE. Save from View on an undecided row must do NOTHING —
   * not record an ignore, which would remove the order from the live queue
   * under a button labelled Save.
   */
  it('does NOT record an ignore when saving from View on an undecided row', () => {
    expect(commitBranch({ action: 'ignored', viewing: true }, null)).toBe('noop');
  });

  it('edits the existing wording when the row has a decision', () => {
    expect(commitBranch({ action: 'ignored', viewing: true }, 'dec-1')).toBe('update');
  });

  it('still records the ignore when Ignore was pressed', () => {
    expect(commitBranch({ action: 'ignored' }, null)).toBe('record-ignore');
  });

  it('still goes to the coupon form when compensating', () => {
    expect(commitBranch({ action: 'compensated' }, null)).toBe('coupon');
  });
});
