import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem, createItems } from '@directus/sdk';
import { buildStoreIndex, type StoreRecord } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * Restaurant master data: brands and their branches ("stores").
 *
 * Owned by operations, edited here, and joined onto Yiji orders so ticket
 * reporting can break down by store, brand and city — none of which the order
 * API supplies on its own (it returns a brand name and a "<city> - <branch>"
 * string, and nothing that maps to the ops team's store codes).
 */

export interface Brand {
  id: string;
  code: string;
  name: string;
  yiji_brand_name: string | null;
  status: 'active' | 'inactive';
}

export interface Store {
  id: string;
  code: string | null;
  name: string;
  city: string | null;
  area_manager: string | null;
  chain_manager: string | null;
  yiji_restaurant_id: string | null;
  status: 'active' | 'inactive';
  brand: { id: string; code: string; name: string; yiji_brand_name?: string | null } | null;
}

const BRAND_FIELDS = ['id', 'code', 'name', 'yiji_brand_name', 'status'] as const;
const STORE_FIELDS = [
  'id',
  'code',
  'name',
  'city',
  'area_manager',
  'chain_manager',
  'yiji_restaurant_id',
  'status',
  'brand.id',
  'brand.code',
  'brand.name',
  'brand.yiji_brand_name',
] as const;

/* ── Brands ───────────────────────────────────────────────────────────── */

export function useBrands() {
  return useQuery({
    queryKey: ['brands'],
    queryFn: () =>
      directus.request(
        readItems('brands', { limit: -1, fields: BRAND_FIELDS as never, sort: ['code'] }),
      ) as Promise<Brand[]>,
  });
}

export interface BrandInput {
  code: string;
  name: string;
  yiji_brand_name?: string | null;
  status?: 'active' | 'inactive';
}

export function useCreateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BrandInput) => directus.request(createItem('brands', input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brands'] }),
  });
}

export function useUpdateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: BrandInput & { id: string }) =>
      directus.request(updateItem('brands', id, patch as never)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brands'] });
      // A brand rename changes the label on every store row too.
      qc.invalidateQueries({ queryKey: ['stores'] });
    },
  });
}

export function useDeleteBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('brands', id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brands'] });
      qc.invalidateQueries({ queryKey: ['stores'] });
    },
  });
}

/* ── Stores ───────────────────────────────────────────────────────────── */

export function useStores() {
  return useQuery({
    queryKey: ['stores'],
    queryFn: () =>
      directus.request(
        readItems('stores', {
          limit: -1,
          fields: STORE_FIELDS as never,
          sort: ['code', 'name'],
        }),
      ) as Promise<Store[]>,
  });
}

export interface StoreInput {
  code?: string | null;
  name: string;
  city?: string | null;
  area_manager?: string | null;
  chain_manager?: string | null;
  yiji_restaurant_id?: string | null;
  status?: 'active' | 'inactive';
  brand?: string | null;
}

export function useCreateStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StoreInput) => directus.request(createItem('stores', input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });
}

export function useUpdateStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: StoreInput & { id: string }) =>
      directus.request(updateItem('stores', id, patch as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });
}

export function useDeleteStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('stores', id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });
}

/**
 * Bulk insert for the CSV import. Chunked because Directus rejects very large
 * payloads and a 200-row sheet is the normal case, not the exception.
 */
export function useBulkCreateStores() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: StoreInput[]) => {
      const CHUNK = 50;
      let created = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        await directus.request(createItems('stores', slice as never));
        created += slice.length;
      }
      return created;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });
}

/** Bulk insert for brands, used by the same import when brands are new. */
export function useBulkCreateBrands() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: BrandInput[]) => {
      if (rows.length === 0) return 0;
      await directus.request(createItems('brands', rows as never));
      return rows.length;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brands'] }),
  });
}

/* ── Shared shaping for the report + dashboards ───────────────────────── */

/** Directus row → the shape the matching module expects. */
export function toStoreRecord(s: Store): StoreRecord {
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

/**
 * Store index for joining orders → stores. Shares the `['stores']` query cache
 * with the CRUD screens, so editing a store immediately changes the report and
 * the dashboards without a reload.
 */
export function useStoreIndex() {
  const stores = useStores();
  const index = buildStoreIndex((stores.data ?? []).map(toStoreRecord));
  return { index, isLoading: stores.isLoading, count: stores.data?.length ?? 0 };
}
