/**
 * Clear the last two unmapped branches.
 *
 * They are different problems and only one is a missing branch:
 *
 *   OKA-013 Hofuf Plaza HASA — a TYPO. The complaints sheet spells the one
 *     Okashi branch at Hofuf Plaza both ways: ten tickets say OK-013 and
 *     attribute fine, eight say OKA-013 and match nothing. Same brand, same
 *     city, and the store list defines it as OK-013 carrying Yiji id 108. So
 *     the eight are re-pointed at the existing branch rather than a second
 *     store being invented, which would split one branch's complaints across
 *     two rows in every report.
 *
 *   CND-009 Nakhil Mall — genuinely absent from both the store list and the
 *     CRM, so it is created (blank managers, like the other ten) and its one
 *     ticket attributed.
 *
 * Dry run unless COMMIT=1:
 *
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node node_modules/vitest/vitest.mjs run \
 *       --config scripts/one-off/vitest.config.ts \
 *       scripts/one-off/fix-last-unmapped.vitest.ts
 */
import { describe, it, expect } from 'vitest';
import { buildStoreIndex, matchStore, toStoreSnapshot, type StoreRecord } from '@yiji/shared-types';

const API = process.env.API ?? 'https://d2vi34f7wgjecb.cloudfront.net';
const EMAIL = process.env.ADMIN_EMAIL ?? '';
const PASS = process.env.ADMIN_PASSWORD ?? '';
const COMMIT = process.env.COMMIT === '1';

/** The branch the sheet misspells, and the code it should have used. */
const TYPO = { wrong: 'OKA-013', right: 'OK-013' };
/** The branch that is genuinely missing. */
const MISSING = { code: 'CND-009', name: 'Nakhil Mall', brand: 'Chick N Dip', city: 'Dammam' };

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
  brand: {
    id?: string;
    code?: string | null;
    name?: string | null;
    yiji_brand_name?: string | null;
  } | null;
}
interface TicketRow {
  id: string;
  store: string | null;
  store_snapshot: { restaurantName?: string; brandName?: string; via?: string } | null;
}

describe('the last two unmapped branches', () => {
  it('re-points the typo and creates the missing branch', async () => {
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
    const storeFields =
      'id,code,name,city,area_manager,chain_manager,yiji_restaurant_id,brand.id,brand.code,brand.name,brand.yiji_brand_name';

    // ── 1. create the genuinely missing branch ───────────────────────────
    let stores = await get<StoreRow>(`/items/stores?limit=-1&fields=${storeFields}`);
    const haveMissing = stores.some((s) => (s.code ?? '') === MISSING.code);
    console.log(`${MISSING.code} already present: ${haveMissing}`);

    if (!haveMissing && COMMIT) {
      const brands = await get<{ id: string; code: string | null; name: string | null }>(
        '/items/brands?limit=-1&fields=id,code,name',
      );
      const brand = brands.find(
        (b) =>
          (b.name ?? '').trim().toLowerCase() === MISSING.brand.toLowerCase() ||
          (b.code ?? '').trim().toLowerCase() === MISSING.brand.toLowerCase(),
      );
      expect(brand, `no brand matches ${MISSING.brand}`).toBeTruthy();
      const r = await fetch(`${API}/items/stores`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          code: MISSING.code,
          name: MISSING.name,
          city: MISSING.city,
          status: 'active',
          brand: brand!.id,
        }),
      });
      if (!r.ok) throw new Error(`create ${MISSING.code}: HTTP ${r.status}`);
      console.log(`created ${MISSING.code} ${MISSING.name}`);
      stores = await get<StoreRow>(`/items/stores?limit=-1&fields=${storeFields}`);
    }

    const index = buildStoreIndex(
      stores.map(
        (s): StoreRecord => ({
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
        }),
      ),
    );

    // ── 2. re-attribute every ticket still frozen as unmapped ────────────
    const tickets = await get<TicketRow>('/items/tickets?limit=-1&fields=id,store,store_snapshot');
    const unmapped = tickets.filter((t) => t.store_snapshot?.via === 'none');
    console.log(`frozen as unmapped: ${unmapped.length}`);

    const capturedAt = new Date().toISOString();
    const fix: Array<{ id: string; from: string; to: string; payload: Record<string, unknown> }> =
      [];
    const stuck: Record<string, number> = {};

    for (const t of unmapped) {
      const branch = t.store_snapshot?.restaurantName ?? '';
      /*
       * The typo is corrected on the way in, not in the database: the sheet
       * is the record of what operations wrote, and rewriting it would hide
       * that the two spellings ever existed. Only the ATTRIBUTION changes.
       */
      const corrected = branch.replace(new RegExp(`^${TYPO.wrong}\\b`), TYPO.right);
      const match = matchStore(index, {
        restaurantName: corrected || null,
        brandName: t.store_snapshot?.brandName ?? null,
      });
      if (!match.store) {
        stuck[branch || '(blank)'] = (stuck[branch || '(blank)'] ?? 0) + 1;
        continue;
      }
      fix.push({
        id: t.id,
        from: branch,
        to: match.restaurantName,
        payload: { store: match.store.id, store_snapshot: toStoreSnapshot(match, capturedAt) },
      });
    }

    const byBranch: Record<string, number> = {};
    for (const f of fix)
      byBranch[`${f.from}  ->  ${f.to}`] = (byBranch[`${f.from}  ->  ${f.to}`] ?? 0) + 1;
    console.log(`resolvable: ${fix.length}`);
    for (const [k, v] of Object.entries(byBranch)) console.log(`   ${String(v).padStart(2)}  ${k}`);
    if (Object.keys(stuck).length) {
      console.log('STILL stuck:');
      for (const [k, v] of Object.entries(stuck)) console.log(`   ${String(v).padStart(2)}  ${k}`);
    }

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
      else console.log(`   ! ${f.from}: HTTP ${r.status}`);
    }
    console.log(`\nre-attributed ${done}/${fix.length}`);
    expect(done).toBe(fix.length);

    const after = await get<TicketRow>('/items/tickets?limit=-1&fields=id,store_snapshot');
    const left = after.filter((t) => t.store_snapshot?.via === 'none');
    const branches = new Set(left.map((t) => t.store_snapshot?.restaurantName || '(blank)'));
    console.log(`\nunmapped ROWS now     : ${left.length}`);
    console.log(`unmapped BRANCHES now : ${branches.size}`);
    expect(left, 'a ticket is still unmapped').toHaveLength(0);
  }, 900_000);
});
