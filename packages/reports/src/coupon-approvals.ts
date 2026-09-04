/**
 * What happened to the coupons agents asked for.
 *
 * Pure arithmetic over the request rows, so the page and any export agree by
 * construction rather than by both being careful. Kept here rather than in the
 * portal because a supervisor's numbers and an agent's numbers have to be the
 * same numbers.
 */

import { couponDecision, couponWasAmended } from '@yiji/shared-types';

export interface CouponApprovalFact {
  /**
   * Any CouponRequestStatus. Classified through `couponDecision`, so 'edited'
   * and 'assigned' count as APPROVED — they are approvals that were amended
   * or delivered, not different outcomes. Anything unrecognised is pending.
   */
  status: string | null;
  /** True when a supervisor changed the terms before approving. */
  editedByAdmin: boolean | null;
  requestedById: string | null;
  requestedByName: string | null;
}

export interface CouponOutcome {
  requested: number;
  /** Approved exactly as asked. */
  approvedAsAsked: number;
  /** Approved, but with the terms changed first. */
  approvedWithChanges: number;
  rejected: number;
  /** Still waiting on a decision. */
  pending: number;
  /** Approved by either route — what an agent means by "did it go through". */
  approvedTotal: number;
}

export interface CouponAgentRow extends CouponOutcome {
  agentId: string | null;
  agentName: string;
}

const EMPTY: CouponOutcome = {
  requested: 0,
  approvedAsAsked: 0,
  approvedWithChanges: 0,
  rejected: 0,
  pending: 0,
  approvedTotal: 0,
};

function tally(into: CouponOutcome, f: CouponApprovalFact): void {
  into.requested += 1;
  // The DECISION, not the literal status. Comparing against 'approved' here
  // put every DELIVERED coupon ('assigned') in the pending bucket, so the
  // queue reported decisions still owed that had been made weeks earlier.
  const decision = couponDecision(f.status);
  if (decision === 'approved') {
    into.approvedTotal += 1;
    // An amended approval is still an approval, but it is a different event and
    // the whole point of the report is being able to see how often it happens.
    if (couponWasAmended(f.status, f.editedByAdmin)) into.approvedWithChanges += 1;
    else into.approvedAsAsked += 1;
  } else if (decision === 'rejected') {
    into.rejected += 1;
  } else {
    into.pending += 1;
  }
}

/** Every request, as one set of totals. */
export function couponOutcomes(facts: readonly CouponApprovalFact[]): CouponOutcome {
  const out = { ...EMPTY };
  for (const f of facts) tally(out, f);
  return out;
}

/**
 * The same totals per agent, busiest first.
 *
 * Requests with no agent on them are grouped under one row rather than dropped:
 * they are still coupons somebody asked for, and hiding them would make the
 * per-agent numbers fail to add up to the total — which is exactly the kind of
 * discrepancy that makes people stop trusting a report.
 */
export function couponOutcomesByAgent(
  facts: readonly CouponApprovalFact[],
  unknownLabel = 'Unknown',
): CouponAgentRow[] {
  const byId = new Map<string, CouponAgentRow>();
  for (const f of facts) {
    const key = f.requestedById ?? '';
    let row = byId.get(key);
    if (!row) {
      row = {
        agentId: f.requestedById,
        // Never blank: a row with no name on it cannot be acted on.
        agentName: f.requestedByName?.trim() || f.requestedById || unknownLabel,
        ...EMPTY,
      };
      byId.set(key, row);
    }
    tally(row, f);
  }
  return [...byId.values()].sort(
    (a, b) => b.requested - a.requested || a.agentName.localeCompare(b.agentName),
  );
}

/**
 * A share of the decided requests, 0–100.
 *
 * Deliberately over DECIDED rather than over everything: while requests are
 * still queued, dividing by the total makes the approval rate look as though it
 * is falling when nothing has been turned down — it is only that more have been
 * asked for. `null` when nothing has been decided at all, because 0% would read
 * as "we approve nothing".
 */
export function couponRate(part: number, o: CouponOutcome): number | null {
  const decided = o.approvedTotal + o.rejected;
  if (decided === 0) return null;
  return (part / decided) * 100;
}
