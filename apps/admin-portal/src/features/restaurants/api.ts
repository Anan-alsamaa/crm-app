import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem, createItems } from '@directus/sdk';
import {
  buildStoreIndex,
  planStoreSnapshotBackfill,
  type OrderRestaurantRef,
  type StoreRecord,
} from '@yiji/shared-types';
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

/**
 * Freeze the current attribution onto any ticket still missing one, BEFORE a
 * store or brand changes underneath it.
 *
 * Tickets record their own attribution when they are raised, so normally there
 * is nothing to do here and this is one cheap filtered read. It exists for the
 * ticket that slipped through anyway — raised before snapshots existed, or by
 * some future path that forgets — because such a ticket would otherwise have
 * its history quietly rewritten by this very edit, and nobody would know.
 *
 * Deliberately automatic rather than a maintenance command: a guarantee that
 * depends on someone remembering to run something is not a guarantee.
 *
 * Best-effort by design. If it cannot run, the edit still proceeds — blocking a
 * legitimate correction because a safety net failed would be the worse outcome.
 */
async function freezeExposedTickets(): Promise<void> {
  try {
    const exposed = (await directus.request(
      readItems(
        'tickets' as never,
        {
          filter: { store_snapshot: { _null: true } },
          fields: ['id', 'order_snapshot'],
          limit: -1,
        } as never,
      ) as never,
    )) as Array<{ id: string; order_snapshot: OrderRestaurantRef | null }>;
    if (exposed.length === 0) return;

    const stores = (await directus.request(
      readItems('stores', { limit: -1, fields: STORE_FIELDS as never }),
    )) as Store[];

    const plan = planStoreSnapshotBackfill(
      exposed.map((t) => ({ id: t.id, storeSnapshot: null, order: t.order_snapshot })),
      buildStoreIndex(stores.map(toStoreRecord)),
      new Date().toISOString(),
    );
    for (const { id, snapshot } of plan.toFreeze) {
      await directus.request(
        updateItem('tickets' as never, id, { store_snapshot: snapshot } as never),
      );
    }
  } catch {
    // See above: never block the edit on the safety net.
  }
}

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
    mutationFn: async ({ id, ...patch }: BrandInput & { id: string }) => {
      // Renaming a brand changes the brand column on every report too.
      await freezeExposedTickets();
      return directus.request(updateItem('brands', id, patch as never));
    },
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
    mutationFn: async (id: string) => {
      await freezeExposedTickets();
      return directus.request(deleteItem('brands', id));
    },
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
    mutationFn: async ({ id, ...patch }: StoreInput & { id: string }) => {
      // Preserve what is true NOW before changing it — afterwards the old
      // values are gone and no report could recover them.
      await freezeExposedTickets();
      return directus.request(updateItem('stores', id, patch as never));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });
}

export function useDeleteStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // A deleted store is the most destructive case of all: every ticket that
      // pointed at it would fall back to "Not mapped" retroactively.
      await freezeExposedTickets();
      return directus.request(deleteItem('stores', id));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });
}

/** What a repeatable import did, in three separate counts. */
export interface ImportOutcome {
  added: number;
  /** Matched an existing branch and changed at least one column. */
  updated: number;
  /** Matched an existing branch and had nothing new to say. */
  alreadyPresent: number;
}

/** Columns the sheet is allowed to write onto an existing branch. */
const UPDATABLE = [
  'name',
  'city',
  'area_manager',
  'chain_manager',
  'brand',
  'status',
  // Present only when the Administrator uploaded it — StoresPage omits the
  // field entirely for anyone else, because it is the join key to the order
  // feed and a wrong value reports tickets against the wrong branch.
  'yiji_restaurant_id',
] as const;

/**
 * Onboard AND maintain stores from an uploaded sheet.
 *
 * The sheet is the operations team's own master, so it is the source of truth
 * for a branch's city, managers and brand. A row that matches an existing
 * branch now UPDATES it; a row that matches nothing is inserted. Nothing is
 * ever deleted: a partial sheet is a normal way to work, and treating absence
 * as "remove" would let one upload wipe the master.
 *
 * The match key is the ops store code, falling back to brand-scoped name when
 * a row has no code (the master packs the code into the name and spells it four
 * ways — see splitStoreCode). Same key as the insert path, so a row cannot be
 * treated as new by one half and existing by the other.
 *
 * Only columns the sheet actually carries are written. A blank cell means "not
 * supplied", never "clear this", otherwise re-uploading a trimmed export would
 * erase the managers someone filled in by hand.
 *
 * `yiji_restaurant_id` reaches this function only when the Administrator
 * uploaded the sheet — StoresPage omits the field entirely for anyone else,
 * and the field-scoped permission in roles.ts rejects it server-side. It is the
 * join key to the order feed: a wrong value does not error, it reports tickets
 * against the wrong branch.
 *
 * Existing rows are re-read HERE rather than taken from the React Query cache:
 * the cache can be minutes old, and deciding "we already have this" from stale
 * data is exactly how a duplicate slips through.
 *
 * Chunked because Directus rejects very large payloads and a 200-row sheet is
 * the normal case, not the exception.
 */
export function useBulkCreateStores() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: StoreInput[]): Promise<ImportOutcome> => {
      const existing = (await directus.request(
        readItems('stores', {
          limit: -1,
          fields: [
            'id',
            'code',
            'name',
            'city',
            'area_manager',
            'chain_manager',
            'status',
            'yiji_restaurant_id',
            'brand.id',
            'brand.code',
          ] as never,
        }),
      )) as Array<
        Record<string, unknown> & {
          id: string;
          code: string | null;
          name: string;
          brand: { id: string; code: string } | null;
        }
      >;

      const byKey = new Map(
        existing.map((s) => [
          storeKey({ code: s.code, name: s.name, brandCode: s.brand?.code }),
          s,
        ]),
      );

      const fresh: StoreInput[] = [];
      const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
      let alreadyPresent = 0;

      for (const row of rows) {
        // The incoming row carries `brand` as an id, not a code, so the
        // brand-scoped name fallback reads the separate `brand_code` the
        // importer attaches for exactly this purpose.
        const match = byKey.get(
          storeKey({ code: row.code, name: row.name, brandCode: row.brand_code }),
        );
        if (!match) {
          fresh.push(row);
          continue;
        }
        const patch: Record<string, unknown> = {};
        for (const field of UPDATABLE) {
          // A row with no code was matched on its NAME, and in the ops master a
          // codeless row is one that packs the code into the name
          // ("LCP058-ARAMCO"). Writing that back would rename the branch to
          // include its own code, so the name is left alone in that case.
          if (field === 'name' && !row.code) continue;
          const incoming = (row as unknown as Record<string, unknown>)[field];
          // Absent or blank means "not supplied by this sheet".
          if (incoming === undefined || incoming === null || incoming === '') continue;
          const current = field === 'brand' ? (match.brand?.id ?? null) : match[field];
          if (String(current ?? '') !== String(incoming)) patch[field] = incoming;
        }
        if (Object.keys(patch).length === 0) alreadyPresent++;
        else patches.push({ id: match.id, patch });
      }

      const CHUNK = 50;
      for (let i = 0; i < fresh.length; i += CHUNK) {
        // `brand_code` is ours, for matching only — Directus has no such field.
        const slice = fresh.slice(i, i + CHUNK).map(({ brand_code: _ignored, ...row }) => row);
        await directus.request(createItems('stores', slice as never));
      }
      if (patches.length > 0) {
        // Same guarantee useUpdateStore makes: preserve what is true NOW before
        // changing it. A sheet upload that edits 130 branches would otherwise
        // rewrite the attribution of every ticket that never froze one.
        await freezeExposedTickets();
        for (const { id, patch } of patches) {
          await directus.request(updateItem('stores', id, patch as never));
        }
      }
      return { added: fresh.length, updated: patches.length, alreadyPresent };
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
      if (rows.length === 0) return { added: 0, updated: 0, alreadyPresent: 0 };

      const existing = (await directus.request(
        readItems('brands', { limit: -1, fields: ['code', 'name'] as never }),
      )) as Array<{ code: string; name: string }>;

      const { fresh, alreadyPresent } = partitionNew(
        rows,
        existing.map((b) => brandKey(b)),
        (r) => brandKey(r),
      );

      if (fresh.length > 0) await directus.request(createItems('brands', fresh as never));
      // Brands are insert-only: the sheet carries a code and a name, and the
      // display name is maintained in the UI, not re-imported over.
      return { added: fresh.length, updated: 0, alreadyPresent };
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
