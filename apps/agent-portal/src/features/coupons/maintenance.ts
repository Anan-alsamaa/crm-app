import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { COUPONS_MAINTENANCE_SETTING_KEY, parseCouponsMaintenance } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * COUPONS UNDER MAINTENANCE (owner, 2026-11-04; a live switch since 2026-11-05).
 *
 * A Private coupon could be used again after the 1st of the month: Yiji resets
 * its "uses per month" count on the calendar month, and the coupon's total
 * ("Total given discount limit", `reachLimit`) was 10000. While the switch is
 * on, NO coupon is raised from this portal - from any of its five doors
 * (Create ticket, Late orders, a ticket's "Assign a coupon", a ticket's coupon
 * fields, Edit coupon).
 *
 * The Administrator flips it in the admin portal: Roles & privileges -> Global
 * settings. It is one `app_settings` row and applies to every user at once.
 * Unknown (loading, no row, failed read) counts as PAUSED - see
 * `parseCouponsMaintenance`.
 */
async function readCouponsMaintenance(): Promise<boolean> {
  try {
    const rows = (await directus.request(
      readItems(
        'app_settings' as never,
        {
          filter: { key: { _eq: COUPONS_MAINTENANCE_SETTING_KEY } },
          fields: ['value'],
          limit: 1,
        } as never,
      ),
    )) as unknown as Array<{ value: unknown }>;
    return parseCouponsMaintenance(rows[0]?.value);
  } catch {
    return true;
  }
}

export const COUPONS_MAINTENANCE_QUERY_KEY = ['coupons-maintenance'] as const;

/**
 * The switch, plus whether it is KNOWN yet. `paused` is true until the setting
 * has been read; `known` lets a caller tell "paused" from "still loading" - so
 * a restored draft is cleared only on a real pause, never on the first render.
 */
export function useCouponsMaintenanceState(): { paused: boolean; known: boolean } {
  const q = useQuery({
    queryKey: COUPONS_MAINTENANCE_QUERY_KEY,
    queryFn: readCouponsMaintenance,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return { paused: q.data ?? true, known: q.data !== undefined };
}

/** Whether coupons are paused right now. `true` until the setting is known. */
export function useCouponsUnderMaintenance(): boolean {
  return useCouponsMaintenanceState().paused;
}

/**
 * The backstop on every send path: read the switch FRESH (never the cached
 * answer) and refuse while it is on, so a page left open from before the
 * pause cannot slip a coupon through.
 */
export async function assertCouponsOpen(): Promise<void> {
  if (await readCouponsMaintenance()) throw new CouponsUnderMaintenanceError();
}

/** Thrown by the send paths if anything still tries to raise a coupon. */
export class CouponsUnderMaintenanceError extends Error {
  constructor() {
    super('Coupons are under maintenance, so this coupon was not sent.');
    this.name = 'CouponsUnderMaintenanceError';
  }
}
