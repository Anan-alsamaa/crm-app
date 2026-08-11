import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem, createItems } from '@directus/sdk';
import { buildStoreIndex, type StoreRecord } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { brandKey, partitionNew, storeKey } from './dedupe.js';

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
  /** Brand id (the Directus relation). */
  brand?: string | null;
  /**
   * Brand CODE, for duplicate matching only — never written to Directus, which
   * has no such field. Only consulted for codeless rows, whose name alone is
   * ambiguous across brands. Stripped from the payload before insert.
   */
  brand_code?: string | null;
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

/** What a repeatable import did: rows inserted vs rows we already had. */
export interface ImportOutcome {
  added: number;
  alreadyPresent: number;
}

/**
 * Bulk insert for the CSV import — REPEATABLE.
 *
 * Uploading the same master twice used to insert every row twice, because this
 * called `createItems` blindly. Now existing rows are skipped: new rows are
 * inserted, known rows are counted, and nothing is ever updated or deleted (a
 * re-upload of a stale sheet must not revert a correction made in the UI).
 *
 * The existing rows are re-read HERE rather than taken from the React Query
 * cache: the cache can be minutes old, and deciding "we already have this" from
 * stale data is exactly how a duplicate slips through.
 *
 * Chunked because Directus rejects very large payloads and a 200-row sheet is
 * the normal case, not the exception.
 */
export function useBulkCreateStores() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: StoreInput[]): Promise<ImportOutcome> => {
      const existing = (await directus.request(
        readItems('stores', { limit: -1, fields: ['code', 'name', 'brand.code'] as never }),
      )) as Array<{ code: string | null; name: string; brand: { code: string } | null }>;

      const { fresh, alreadyPresent } = partitionNew(
        rows,
        existing.map((s) => storeKey({ code: s.code, name: s.name, brandCode: s.brand?.code })),
        // The incoming row carries `brand` as an id, not a code, so the
        // brand-scoped name fallback reads the separate `brand_code` the
        // importer attaches for exactly this purpose.
        (r) => storeKey({ code: r.code, name: r.name, brandCode: r.brand_code }),
      );

      const CHUNK = 50;
      for (let i = 0; i < fresh.length; i += CHUNK) {
        // `brand_code` is ours, for matching only — Directus has no such field.
        const slice = fresh.slice(i, i + CHUNK).map(({ brand_code: _ignored, ...row }) => row);
        await directus.request(createItems('stores', slice as never));
      }
      return { added: fresh.length, alreadyPresent };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });
}

/**
 * Bulk insert for brands, used by the same import when brands are new.
 * Repeatable on the same terms as the stores import above.
 */
export function useBulkCreateBrands() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: BrandInput[]): Promise<ImportOutcome> => {
      if (rows.length === 0) return { added: 0, alreadyPresent: 0 };

      const existing = (await directus.request(
        readItems('brands', { limit: -1, fields: ['code', 'name'] as never }),
      )) as Array<{ code: string; name: string }>;

      const { fresh, alreadyPresent } = partitionNew(
        rows,
        existing.map((b) => brandKey(b)),
        (r) => brandKey(r),
      );

      if (fresh.length > 0) await directus.request(createItems('brands', fresh as never));
      return { added: fresh.length, alreadyPresent };
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
