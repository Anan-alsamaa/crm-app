import { pickSlaPolicy, vendorIdOf, type SlaPolicyScope, type VendorRef } from '@yiji/shared-types';

/**
 * THE TWO TICKET TIMINGS THE DEADLINES REPORT SHOWS, and why they were blank.
 *
 * Measured on production, 14-15 Oct 2026: 16 tickets, all solved, and the
 * report showed "Resolution: —" on 12 and "1st reply: —" on 14. Two faults, both
 * silent (see silent-empty-failures):
 *
 *  1. NO TARGET ON A TICKET SOLVED BEFORE THE SWEEP. The SLA sweep runs once a
 *     minute and only over UNSOLVED tickets. Agents raise a ticket from a chat
 *     and close it 5-20 seconds later, so the sweep never saw 12 of the 16 —
 *     no policy attached, no `resolution_due_at`, rendered as "no target" even
 *     though the ticket policy covers every priority.
 *
 *  2. THE SOLVE / REPLY STAMPS COME FROM THE AGENT'S PC CLOCK. `resolved_at`
 *     and `first_responded_at` are written with the browser's `new Date()`,
 *     `date_created` by the server. The agents' clocks run ~2.5 minutes
 *     behind, so a ticket solved 5 seconds after it was raised carries a solve
 *     time 2.5 minutes BEFORE its creation — a negative interval, which every
 *     duration helper (correctly) returns as null.
 *
 * The fixes are read-side only; nothing is written back. Fault 2 is handled by
 * the shared rule in @yiji/reports (`ticketSolveSec` / `ticketChatSession`),
 * fed by `loadTicketSolveContext`; this file keeps the policy pick for fault 1.
 */

/** A ticket policy as the report reads it. */
export interface ReportSlaPolicy extends SlaPolicyScope {
  id: string;
  name?: string | null;
  active?: boolean | null;
  resolution_minutes?: number | null;
  date_created?: string | null;
  vendor?: VendorRef;
}

/**
 * The ticket policy that governs this ticket, exactly as the sweep would pick
 * it: active, the ticket's own vendor's policies before the shared ones, most
 * specific coverage wins, and never a policy written AFTER the ticket was
 * raised (a policy cannot promise backwards).
 */
export function governingPolicy<P extends ReportSlaPolicy>(
  policies: readonly P[],
  facts: {
    priority: string | null;
    complaintType?: string | null;
    complaintSource?: string | null;
    brandName?: string | null;
    vendor?: VendorRef;
    createdAt: string | null;
  },
): P | null {
  const active = policies.filter((p) => p.active !== false);
  const vendor = vendorIdOf(facts.vendor);
  const own = vendor ? active.filter((p) => vendorIdOf(p.vendor) === vendor) : [];
  const shared = active.filter((p) => !vendorIdOf(p.vendor));
  const match = {
    priority: facts.priority,
    complaintType: facts.complaintType ?? null,
    complaintSource: facts.complaintSource ?? null,
    brandName: facts.brandName ?? null,
  };
  const policy =
    (own.length > 0 ? pickSlaPolicy(own, match, 'ticket') : null) ??
    pickSlaPolicy(shared, match, 'ticket');
  if (!policy) return null;
  if (
    policy.date_created &&
    facts.createdAt &&
    new Date(facts.createdAt).getTime() < new Date(policy.date_created).getTime()
  ) {
    return null;
  }
  return policy;
}
