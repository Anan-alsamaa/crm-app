/**
 * COUPONS UNDER MAINTENANCE (owner, 2026-11-04).
 *
 * A Private coupon could be used again after the 1st of the month: Yiji resets
 * its "uses per month" count on the calendar month, and the coupon's total
 * ("Total given discount limit", `reachLimit`) was 10000. Five customers used a
 * coupon twice on 1-2 Nov. Until the total limit is fixed, NO coupon is raised
 * from this portal - from any of its five doors (Create ticket, Late orders,
 * a ticket's "Assign a coupon", a ticket's coupon fields, Edit coupon).
 *
 * Turning it back on is a code change on purpose: it ships with the fix.
 */
export const COUPONS_UNDER_MAINTENANCE = true;

/** Thrown by the send paths if anything still tries to raise a coupon. */
export class CouponsUnderMaintenanceError extends Error {
  constructor() {
    super('Coupons are under maintenance, so this coupon was not sent.');
    this.name = 'CouponsUnderMaintenanceError';
  }
}
