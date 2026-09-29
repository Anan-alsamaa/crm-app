import { describe, it, expect } from 'vitest';
import { planTicket } from '../src/features/late-orders/LateOrdersPage.js';

/**
 * ONE ORDER, ONE TICKET — and only for late preparation.
 *
 * Two owner decisions from 2026-09-28, pinned together because they are the
 * whole rule for when a late-order decision files a complaint:
 *
 * 1. Order 1323291 grew FOUR tickets. An agent submitted four decisions minutes
 *    apart and each raised its own, so the ticket-breakdown report counted one
 *    late preparation four times. A repeat decision now reuses the first
 *    ticket.
 *
 * 2. A late DELIVERY raises no ticket at all. Confirmed on production — order
 *    1323074 was compensated with no ticket — and the owner's call is that this
 *    stays: delivery lateness is not a complaint in its own right, and the
 *    coupon is the record.
 *
 * The prior id comes from the DECISION, not from a search by order id, so a
 * ticket somebody raised by hand from the tickets page for the same order is
 * never silently adopted.
 */
describe('planTicket', () => {
  it('raises a ticket for the first late-preparation decision', () => {
    expect(planTicket('late_preparation', null)).toEqual({ mode: 'raise' });
  });

  it('REUSES the ticket a previous decision on the same order raised', () => {
    expect(planTicket('late_preparation', 'tkt-1')).toEqual({ mode: 'reuse', id: 'tkt-1' });
  });

  /* A late delivery never files one, decided or not — the owner's call. */
  it('raises nothing for a late delivery', () => {
    expect(planTicket('late_delivery', null)).toEqual({ mode: 'none' });
  });

  it('raises nothing for a late delivery even when a ticket somehow exists', () => {
    expect(planTicket('late_delivery', 'tkt-1')).toEqual({ mode: 'none' });
  });

  /*
   * An empty or blank column is NOT a ticket. Directus stores an unset relation
   * as null, but a stray empty string would otherwise be "reused" as an id and
   * the decision would point at a ticket that does not exist.
   */
  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
  ])('treats a %s prior ticket as none at all, and raises', (_label, prior) => {
    expect(planTicket('late_preparation', prior)).toEqual({ mode: 'raise' });
  });

  it('trims the id it reuses', () => {
    expect(planTicket('late_preparation', '  tkt-2  ')).toEqual({ mode: 'reuse', id: 'tkt-2' });
  });
});
