/**
 * Freeze the branch attribution onto tickets that were raised before
 * `tickets.store_snapshot` existed.
 *
 * WHY — reports used to resolve the store live, so editing one field today
 * changed every report ever produced. New tickets now carry a frozen
 * attribution, but older ones have nothing to read back and would keep
 * resolving live: edit a branch's area manager and those older complaints
 * would still be reassigned to someone who never handled them.
 *
 * This closes that gap. After a run, no ticket's reported branch, brand, city
 * or manager can move because a store was edited.
 *
 * HONEST LIMITATION — the values a backfilled ticket gets are the store as it
 * stands TODAY, not as it stood when the ticket was raised. That history was
 * never recorded and cannot be recovered. Every row written here is therefore
 * flagged `backfilled: true`, so a reconstruction is never mistaken for a real
 * capture. Run it BEFORE editing stores, not after, and it is exact.
 *
 * SAFE BY CONSTRUCTION:
 *   - only ever fills a snapshot that is missing; never overwrites one
 *   - touches no other field on the ticket
 *   - dry run by default; writes only with --apply
 *   - re-running is a no-op
 *
 *   pnpm --filter @yiji/directus-bootstrap backfill:store-snapshots
 *   pnpm --filter @yiji/directus-bootstrap backfill:store-snapshots -- --apply
 */
import {
  buildStoreIndex,
  planStoreSnapshotBackfill,
  type StoreRecord,
  type StoreSnapshot,
} from '@yiji/shared-types';

const DIRECTUS = process.env.DIRECTUS_INTERNAL_URL ?? 'http://localhost:8055';
const ADMIN_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const ADMIN_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

const APPLY = process.argv.slice(2).includes('--apply');

let TOKEN = '';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${DIRECTUS}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

interface RawStore {
  id: string;
  code: string | null;
  name: string;
  city: string | null;
  area_manager: string | null;
  chain_manager: string | null;
  yiji_restaurant_id: string | null;
  brand: { code: string; name: string; yiji_brand_name: string | null } | null;
}

interface RawTicket {
  id: string;
  date_created: string | null;
  store_snapshot: unknown;
  order_snapshot: {
    restaurantId?: string | null;
    restaurantName?: string | null;
    brandName?: string | null;
  } | null;
}

async function main(): Promise<void> {
  TOKEN = (
    await api<{ data: { access_token: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    })
  ).data.access_token;

  const stores = (
    await api<{ data: RawStore[] }>(
      '/items/stores?limit=-1&fields=id,code,name,city,area_manager,chain_manager,yiji_restaurant_id,brand.code,brand.name,brand.yiji_brand_name',
    )
  ).data;

  const index = buildStoreIndex(
    stores.map(
      (s): StoreRecord => ({
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
      }),
    ),
  );

  const tickets = (
    await api<{ data: RawTicket[] }>(
      '/items/tickets?limit=-1&fields=id,date_created,store_snapshot,order_snapshot',
    )
  ).data;

  // The decision rules live in @yiji/shared-types so they are unit-tested
  // without a database: never overwrite an existing snapshot, never invent one
  // for a ticket with no order.
  const plan = planStoreSnapshotBackfill(
    tickets.map((t) => ({
      id: t.id,
      storeSnapshot: (t.store_snapshot as StoreSnapshot | null) ?? null,
      order: t.order_snapshot,
    })),
    index,
    new Date().toISOString(),
  );
  const { toFreeze, alreadyFrozen: already, noOrder, unmapped } = plan;

  console.log(`tickets                     ${tickets.length}`);
  console.log(`  already frozen (skipped)  ${already}`);
  console.log(`  no order to attribute     ${noOrder}`);
  console.log(`  to freeze                 ${toFreeze.length}`);
  console.log(`    of which unmapped store ${unmapped}`);

  if (toFreeze.length === 0) {
    console.log('\nNothing to do.');
    return;
  }
  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write.');
    return;
  }

  let written = 0;
  for (const { id, snapshot } of toFreeze) {
    await api(`/items/tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ store_snapshot: snapshot }),
    });
    written += 1;
  }
  console.log(`\nFrozen ${written} ticket(s). Re-running is now a no-op.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
