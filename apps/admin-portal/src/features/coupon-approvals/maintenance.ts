import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { COUPONS_MAINTENANCE_SETTING_KEY, parseCouponsMaintenance } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * COUPONS UNDER MAINTENANCE, as the admin portal reads it (owner, 2026-11-04).
 *
 * The Administrator's global switch (Roles & privileges -> Global settings),
 * one `app_settings` row. While it is on, nothing on this portal changes a
 * coupon on Yiji either - the "Edit coupon" on an approval card becomes a
 * notice. Unknown (loading, no row, failed read) counts as PAUSED, the same
 * reading as the agent portal's (`parseCouponsMaintenance`).
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

/** Whether coupons are paused right now. `true` until the setting is known. */
export function useCouponsUnderMaintenance(): boolean {
  const q = useQuery({
    queryKey: COUPONS_MAINTENANCE_QUERY_KEY,
    queryFn: readCouponsMaintenance,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return q.data ?? true;
}

/**
 * The backstop on the edit path: read the switch FRESH (never the cached
 * answer) and refuse while it is on, so a page left open from before the
 * pause cannot change a coupon on Yiji.
 */
export async function assertCouponsOpen(): Promise<void> {
  if (await readCouponsMaintenance()) throw new CouponsUnderMaintenanceError();
}

export class CouponsUnderMaintenanceError extends Error {
  constructor() {
    super('Coupons are under maintenance, so this coupon was not changed.');
    this.name = 'CouponsUnderMaintenanceError';
  }
}
