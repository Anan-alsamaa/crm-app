import { describe, it, expect } from 'vitest';
import { kindOf, labelTaken } from '../src/features/lists/QuickRepliesSection.js';

/**
 * THE THREE READY-WORDING LIBRARIES, AND WHAT KEEPS THEM APART.
 *
 * `quick_replies` holds three sets that must not pool (ops, 2026-10-04): the
 * inbox's `chat` replies, and the late-order decision box's `late_order_reason`
 * and `late_order_action`. They answer three different questions — a chat reply
 * is addressed to a CUSTOMER, a reason explains why an order was late, an
 * action says what was done about it — so one shared list would offer an agent
 * mostly wrong answers in all three places.
 *
 * This section had NO tests. Both rules below are pure, both are three
 * conditions that have to agree, and getting either wrong is quiet: an operator
 * is refused an edit they are entitled to make, or sees a library that is not
 * theirs.
 */

describe('which library a row belongs to', () => {
  it.each(['chat', 'late_order_reason', 'late_order_action'])('keeps a known kind: %s', (k) => {
    expect(kindOf({ kind: k })).toBe(k);
  });

  /*
   * ROWS WRITTEN BEFORE THE COLUMN EXISTED have no `kind`, and they came from
   * the chat library — the only one that existed. Reading them as `chat` is
   * what lets an environment where the field has not been created yet still
   * show operations their inbox replies instead of an empty page. The agent
   * portal's `useQuickReplies` makes the identical assumption; two different
   * answers here would put a row in one library on one screen and another on
   * the other.
   */
  it.each([null, undefined, ''])('reads a missing kind as chat (%s)', (k) => {
    expect(kindOf({ kind: k })).toBe('chat');
  });

  /* An unrecognised value is chat too, not a fourth library. A typo in the
     database must not create a tab nobody can reach. */
  it('reads an unknown kind as chat rather than inventing a library', () => {
    expect(kindOf({ kind: 'late_order_banana' })).toBe('chat');
    expect(kindOf({})).toBe('chat');
  });
});

/**
 * THE DUPLICATE CHECK IS PER LIBRARY.
 *
 * A global check was right while there was one list and is wrong now:
 * "Compensated" is a perfectly good ACTION and a perfectly good chat reply, the
 * agent never sees the two together, and refusing the second would have
 * operations inventing second names for wordings that do not clash.
 */
const ROWS = [
  { id: 'c1', label: 'Opening', kind: 'chat' },
  { id: 'c2', label: 'Compensated', kind: 'chat' },
  { id: 'r1', label: 'Kitchen delay', kind: 'late_order_reason' },
  { id: 'a1', label: 'Called the branch', kind: 'late_order_action' },
  /* A pre-column row: no `kind` at all, and it belongs to `chat`. */
  { id: 'old', label: 'Legacy wording', kind: null },
];

describe('whether a label is already taken', () => {
  it('refuses a label that exists in the same library', () => {
    expect(labelTaken(ROWS, 'Opening', 'chat')).toBe(true);
  });

  /* THE WHOLE POINT. */
  it('allows the same label in a different library', () => {
    expect(labelTaken(ROWS, 'Compensated', 'late_order_action')).toBe(false);
    expect(labelTaken(ROWS, 'Opening', 'late_order_reason')).toBe(false);
  });

  /* Operations type labels by hand; case is not a distinction. */
  it('ignores case', () => {
    expect(labelTaken(ROWS, 'OPENING', 'chat')).toBe(true);
    expect(labelTaken(ROWS, '  opening  ', 'chat')).toBe(true);
  });

  /*
   * RENAMING A ROW TO ITS OWN CURRENT LABEL is leaving it alone, not a
   * duplicate — without `excludeId` an operator could not edit the TEXT of a
   * reply without also renaming its button.
   */
  it('does not count the row being edited', () => {
    expect(labelTaken(ROWS, 'Opening', 'chat', 'c1')).toBe(false);
    /* But it still catches a collision with a DIFFERENT row. */
    expect(labelTaken(ROWS, 'Compensated', 'chat', 'c1')).toBe(true);
  });

  /*
   * CHECKED AGAINST THE DESTINATION, not the row's current library. Moving
   * "Opening" into the reasons must collide with an existing REASON and must
   * not collide with the chat reply it is leaving behind.
   */
  it('checks the library the row is moving INTO', () => {
    /* `c1` is a chat reply called "Opening" being moved to reasons: no reason
       is called that, so the move is allowed. */
    expect(labelTaken(ROWS, 'Opening', 'late_order_reason', 'c1')).toBe(false);
    /* Moving it to a name a reason already has is refused. */
    expect(labelTaken(ROWS, 'Kitchen delay', 'late_order_reason', 'c1')).toBe(true);
  });

  /* A pre-column row counts as `chat`, so a new chat reply cannot steal its
     label. */
  it('counts a row with no kind as part of the chat library', () => {
    expect(labelTaken(ROWS, 'Legacy wording', 'chat')).toBe(true);
    expect(labelTaken(ROWS, 'Legacy wording', 'late_order_action')).toBe(false);
  });

  /* An empty label is not a duplicate — the form rejects it for being empty,
     and reporting "already taken" would send the operator looking for a row
     that does not exist. */
  it.each(['', '   '])('is not a duplicate when there is no label (%s)', (l) => {
    expect(labelTaken(ROWS, l, 'chat')).toBe(false);
  });

  it('allows a label nobody has used', () => {
    expect(labelTaken(ROWS, 'Something new', 'chat')).toBe(false);
  });
});
