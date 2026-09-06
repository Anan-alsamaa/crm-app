/**
 * Re-attribute the tickets that were frozen before their branch existed.
 *
 * A ticket's branch is FROZEN onto it as a `store_snapshot` when it is raised,
 * and the report trusts that snapshot over any later match — deliberately, so
 * editing a store cannot rewrite what a historical ticket reports.
 *
 * That is right except in one case: the branch did not exist in the store
 * master at the time, so the snapshot froze "unmapped" as the answer. Adding
 * the branch afterwards changes nothing, because nothing re-reads it. This
 * re-freezes ONLY those — snapshots whose `via` is `none` — and only where the
 * branch now resolves.
 *
 * It will not touch a ticket that was successfully attributed. There is no
 * case for re-running attribution on those: their snapshot is the record.
 *
 * Dry run unless COMMIT=1:
 *
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node node_modules/vitest/vitest.mjs run \
 *       --config scripts/one-off/vitest.config.ts \
 *       scripts/one-off/refreeze-unmapped.vitest.ts
 */
import { describe, it, expect } from 'vitest';
import { buildStoreIndex, matchStore, toStoreSnapshot, type StoreRecord } from '@yiji/shared-types';

const API = process.env.API ?? 'https://d2vi34f7wgjecb.cloudfront.net';
const EMAIL = process.env.ADMIN_EMAIL ?? '';
const PASS = process.env.ADMIN_PASSWORD ?? '';
const COMMIT = process.env.COMMIT === '1';

interface Envelope<T> {
  data?: T;
  errors?: unknown;
}
interface StoreRow {
  id: string;
  code: string | null;
  name: string | null;
  city: string | null;
  area_manager: string | null;
  chain_manager: string | null;
  yiji_restaurant_id: string | null;
  brand: { code?: string | null; name?: string | null; yiji_brand_name?: string | null } | null;
}
interface TicketRow {
  id: string;
  store: string | null;
  store_snapshot: { restaurantName?: string; brandName?: string; via?: string } | null;
}

describe('re-freeze tickets whose branch has since been added', () => {
  it('re-attributes only the ones frozen as unmapped', async () => {
    if (!EMAIL || !PASS) throw new Error('set ADMIN_EMAIL and ADMIN_PASSWORD');

    const login = (await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then((r) => r.json())) as Envelope<{ access_token?: string }>;
    if (!login.data?.access_token) throw new Error('login failed');
    const H = {
      Authorization: `Bearer ${login.data.access_token}`,
      'Content-Type': 'application/json',
    };

    const get = async <T>(p: string): Promise<T[]> => {
      const r = (await fetch(`${API}${p}`, { headers: H }).then((x) => x.json())) as Envelope<T[]>;
      if (r.errors) throw new Error(`${p}: ${JSON.stringify(r.errors).slice(0, 200)}`);
      return r.data ?? [];
    };

    const storeRows = await get<StoreRow>(
      '/items/stores?limit=-1&fields=id,code,name,city,area_manager,chain_manager,yiji_restaurant_id,brand.code,brand.name,brand.yiji_brand_name',
    );
    const stores: StoreRecord[] = storeRows.map((s) => ({
      id: s.id,
      code: s.code ?? null,
      name: s.name ?? '',
      city: s.city ?? null,
      areaManager: s.area_manager ?? null,
      chainManager: s.chain_manager ?? null,
      brandCode: s.brand?.code ?? null,
      brandName: s.brand?.name ?? null,
      brandYijiName: s.brand?.yiji_brand_name ?? null,
      yijiRestaurantId: s.yiji_restaurant_id ?? null,
    }));
    const index = buildStoreIndex(stores);

    const tickets = await get<TicketRow>('/items/tickets?limit=-1&fields=id,store,store_snapshot');
    const frozenUnmapped = tickets.filter((t) => t.store_snapshot?.via === 'none');

    const capturedAt = new Date().toISOString();
    const fix: Array<{ id: string; branch: string; payload: Record<string, unknown> }> = [];
    const stillUnmapped: Record<string, number> = {};

    for (const t of frozenUnmapped) {
      const branch = t.store_snapshot?.restaurantName ?? '';
      const match = matchStore(index, {
        restaurantName: branch || null,
        brandName: t.store_snapshot?.brandName ?? null,
      });
      if (!match.store) {
        stillUnmapped[branch || '(blank)'] = (stillUnmapped[branch || '(blank)'] ?? 0) + 1;
        continue;
      }
      fix.push({
        id: t.id,
        branch,
        payload: { store: match.store.id, store_snapshot: toStoreSnapshot(match, capturedAt) },
      });
    }

    console.log(`frozen as unmapped : ${frozenUnmapped.length}`);
    console.log(`now resolvable     : ${fix.length}`);
    console.log(`still unmapped     : ${Object.values(stillUnmapped).reduce((a, b) => a + b, 0)}`);
    for (const [k, v] of Object.entries(stillUnmapped))
      console.log(`   ${String(v).padStart(3)}  ${k}`);

    if (!COMMIT) {
      console.log('\nDRY RUN — nothing written. Re-run with COMMIT=1.');
      return;
    }

    let done = 0;
    for (const f of fix) {
      const r = await fetch(`${API}/items/tickets/${f.id}`, {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify(f.payload),
      });
      if (r.ok) done += 1;
      else console.log(`   ! ${f.branch}: HTTP ${r.status}`);
    }
    console.log(`\nre-attributed ${done}/${fix.length}`);
    expect(done).toBe(fix.length);

    const after = await get<TicketRow>('/items/tickets?limit=-1&fields=id,store_snapshot');
    const left = after.filter((t) => t.store_snapshot?.via === 'none').length;
    console.log(`tickets still showing as unmapped: ${left}`);
  }, 900_000);
});
