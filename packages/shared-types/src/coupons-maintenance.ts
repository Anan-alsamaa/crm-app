/**
 * THE GLOBAL "COUPONS UNDER MAINTENANCE" SWITCH (owner, 2026-11-05).
 *
 * One `app_settings` row, flipped by the Administrator from Roles & privileges
 * -> Global settings. It applies to EVERY user at once - it is not a privilege
 * of one role. While it is on, no coupon is raised from the agent portal.
 *
 * FAIL-SAFE: no row, an unreadable value, or a failed read all mean PAUSED.
 * Coupons resume only when the row explicitly says off, so an outage or a
 * missing row can never quietly reopen coupons the owner paused.
 */
export const COUPONS_MAINTENANCE_SETTING_KEY = 'coupons_under_maintenance';

/** `true` = paused. Only an explicit off ("false", false, "off", "0") resumes. */
export function parseCouponsMaintenance(value: unknown): boolean {
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'false' || v === 'off' || v === '0') return false;
  }
  return true;
}

/** The stored value for a switch position. */
export function couponsMaintenanceValue(on: boolean): string {
  return on ? 'true' : 'false';
}
