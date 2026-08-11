import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { buildStoreIndex, matchStore, type StoreMatch, type StoreRecord } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * Resolve an order's branch against the operations store list, for the AGENT
 * portal.
 *
 * Agents get read-only access to `stores`/`brands` so the order card can show
 * where an order actually came from — the city and the responsible managers,
 * which the Yiji order API never returns. Without this an agent sees only
 * "La Casa Pasta — Riyadh - Masief Plaza" and has to ask someone which branch
 * that is and who owns it.
 *
 * Cached for the session: this is slow-moving master data, and the card renders
 * once per ticket, so refetching per render would be pure waste.
 */
export interface StoreRow {
  id: string;
  code: string | null;
  name: string;
  city: string | null;
  area_manager: string | null;
  chain_manager: string | null;
  yiji_restaurant_id: string | null;
  brand: { id: string; code: string; name: string; yiji_brand_name?: string | null } | null;
}

/**
 * The operations store master, as rows — for the branch picker on the complaint
 * form, which needs to list and search the branches rather than match one order
 * against them. Shares `useStoreIndex`'s query key, so both read one cached copy.
 */
export function useStores() {
  return useQuery({
    queryKey: ['agent-stores'],
    staleTime: 10 * 60_000,
    queryFn: () =>
      directus.request(
        readItems('stores' as never, {
          limit: -1,
          fields: [
            'id',
            'code',
            'name',
            'city',
            'area_manager',
            'chain_manager',
            'yiji_restaurant_id',
            'brand.id',
            'brand.code',
            'brand.name',
            'brand.yiji_brand_name',
          ],
        }) as never,
      ) as Promise<StoreRow[]>,
    // A missing/forbidden stores collection must not break the order card.
    retry: false,
  });
}

/**
 * Directus row → the shape the matching module speaks. One mapping, so a field
 * added to the query cannot reach the matcher through one path and not another.
 */
export function toStoreRecord(s: StoreRow): StoreRecord {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    city: s.city,
    areaManager: s.area_manager,
    chainManager: s.chain_manager,
    brandCode: s.brand?.code ?? null,
    brandName: s.brand?.name ?? null,
    brandYijiName: s.brand?.yiji_brand_name ?? null,
    yijiRestaurantId: s.yiji_restaurant_id,
  };
}

export function useStoreIndex() {
  const q = useStores();

  const index = buildStoreIndex((q.data ?? []).map(toStoreRecord));
  return { index, isLoading: q.isLoading, count: q.data?.length ?? 0 };
}

/** Convenience: resolve one order in a component. */
export function useOrderStore(order: {
  restaurantId?: string | null;
  restaurantName?: string | null;
  brandName?: string | null;
}): StoreMatch {
  const { index } = useStoreIndex();
  return matchStore(index, order);
}
