import { describe, it, expect } from 'vitest';
import {
  couponOutcomes,
  couponOutcomesByAgent,
  couponRate,
  type CouponApprovalFact,
} from '../src/coupon-approvals.js';
import { COUPON_APPROVED_STATUSES, CouponRequestStatus, couponDecision } from '@yiji/shared-types';

describe('couponDecision and COUPON_APPROVED_STATUSES', () => {
  it('agree on which statuses are approvals', () => {
    // The list exists only because a Directus `_in` filter cannot call the
    // function. If someone adds a status to one and not the other, the
    // Approved tab and the approved COUNT quietly disagree — which is the
    // exact bug this replaced. Derive both from the enum and compare.
    const fromSwitch = CouponRequestStatus.options.filter((s) => couponDecision(s) === 'approved');
    expect([...COUPON_APPROVED_STATUSES].sort()).toEqual(fromSwitch.sort());
  });

  it('classifies every enum member, never falling to the default', () => {
    for (const s of CouponRequestStatus.options) {
      const d = couponDecision(s);
      expect(['approved', 'rejected', 'pending']).toContain(d);
      // Only 'pending' itself may be pending: an enum member that lands in
      // the default branch is an unclassified status, not an undecided one.
      if (d === 'pending') expect(s).toBe('pending');
    }
  });

  it('treats unknown, null and casing as the tests above expect', () => {
    expect(couponDecision(null)).toBe('pending');
    expect(couponDecision('ASSIGNED')).toBe('approved');
    expect(couponDecision(' Edited ')).toBe('approved');
    expect(couponDecision('escalated')).toBe('pending');
  });
});

const f = (
  status: string | null,
  editedByAdmin = false,
  requestedById: string | null = 'a1',
  requestedByName: string | null = 'Saad',
): CouponApprovalFact => ({ status, editedByAdmin, requestedById, requestedByName });

describe('couponOutcomes', () => {
  it('separates an amended approval from a straight one', () => {
    // Both went through; only one went through as asked. Collapsing them would
    // hide the thing the report exists to show.
    const o = couponOutcomes([f('approved'), f('approved', true), f('rejected'), f('pending')]);
    expect(o).toMatchObject({
      requested: 4,
      approvedAsAsked: 1,
      approvedWithChanges: 1,
      approvedTotal: 2,
      rejected: 1,
      pending: 1,
    });
  });

  it('counts an unrecognised status as undecided rather than dropping it', () => {
    // A request that vanishes from the totals is worse than one in the wrong
    // bucket: the columns stop adding up and nobody trusts the page again.
    const o = couponOutcomes([f('escalated'), f(null)]);
    expect(o.requested).toBe(2);
    expect(o.pending).toBe(2);
  });

  /*
   * The status-conflation regression.
   *
   * Five statuses, but three of them ('approved', 'edited', 'assigned') are
   * all APPROVALS that differ only in what happened next. The tally used to
   * match the literal 'approved', so a coupon that had been approved AND
   * delivered to Yiji ('assigned') fell into the pending bucket — and the
   * staging queue reported five decisions still owed weeks after they were
   * made. Found by auditing the dashboard against the database.
   */
  it('counts a DELIVERED coupon (assigned) as approved, not pending', () => {
    const o = couponOutcomes([f('assigned'), f('assigned')]);
    expect(o.approvedTotal).toBe(2);
    expect(o.approvedAsAsked).toBe(2);
    expect(o.pending).toBe(0);
  });

  it('counts an amended approval (edited) as approved WITH changes', () => {
    // 'edited' is the status an admin leaves when they change the terms and
    // approve in one action, so it is an approval-with-changes by definition —
    // even when the editedByAdmin flag was not set alongside it.
    const o = couponOutcomes([f('edited'), f('edited', true)]);
    expect(o.approvedTotal).toBe(2);
    expect(o.approvedWithChanges).toBe(2);
    expect(o.approvedAsAsked).toBe(0);
    expect(o.pending).toBe(0);
  });

  it('adds up across ALL five statuses', () => {
    const o = couponOutcomes([
      f('pending'),
      f('approved'),
      f('edited'),
      f('rejected'),
      f('assigned'),
    ]);
    expect(o.requested).toBe(5);
    expect(o.approvedTotal).toBe(3);
    expect(o.rejected).toBe(1);
    expect(o.pending).toBe(1);
    expect(o.approvedTotal + o.rejected + o.pending).toBe(o.requested);
  });

  it('adds up', () => {
    const o = couponOutcomes([f('approved'), f('approved', true), f('rejected'), f(null)]);
    expect(o.approvedTotal + o.rejected + o.pending).toBe(o.requested);
    expect(o.approvedAsAsked + o.approvedWithChanges).toBe(o.approvedTotal);
  });
});

describe('couponOutcomesByAgent', () => {
  it('keeps unassigned requests visible so the rows still sum to the total', () => {
    const facts = [f('approved'), f('rejected', false, null, null)];
    const rows = couponOutcomesByAgent(facts);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, r) => n + r.requested, 0)).toBe(couponOutcomes(facts).requested);
  });

  it('never leaves a row without a name', () => {
    const rows = couponOutcomesByAgent([f('approved', false, 'a9', '   ')], 'Unknown');
    // Falls back to the id, then to the label — ugly beats anonymous, because a
    // row nobody can identify cannot be acted on.
    expect(rows[0]!.agentName).toBe('a9');
    expect(couponOutcomesByAgent([f('approved', false, null, null)], 'Unknown')[0]!.agentName).toBe(
      'Unknown',
    );
  });

  it('puts the busiest agent first', () => {
    const rows = couponOutcomesByAgent([
      f('approved', false, 'a1', 'Saad'),
      f('approved', false, 'a2', 'Nouf'),
      f('rejected', false, 'a2', 'Nouf'),
    ]);
    expect(rows.map((r) => r.agentName)).toEqual(['Nouf', 'Saad']);
  });
});

describe('couponRate', () => {
  it('is a share of what has been DECIDED, not of everything asked for', () => {
    // Two approved, one rejected, six still queued. The approval rate is 67%,
    // not 22% — queued requests are not refusals, and dividing by the total
    // makes the rate appear to collapse as volume rises.
    const o = couponOutcomes([
      f('approved'),
      f('approved'),
      f('rejected'),
      ...Array.from({ length: 6 }, () => f('pending')),
    ]);
    expect(couponRate(o.approvedTotal, o)).toBeCloseTo(66.67, 1);
  });

  it('is null when nothing has been decided, because 0% would be a lie', () => {
    const o = couponOutcomes([f('pending'), f('pending')]);
    expect(couponRate(o.approvedTotal, o)).toBeNull();
  });

  it('reaches 100 when everything decided went through', () => {
    const o = couponOutcomes([f('approved'), f('approved', true)]);
    expect(couponRate(o.approvedTotal, o)).toBe(100);
  });
});
