/**
 * Bring the store master in line with the operations store list.
 *
 * The owner's file (`Ayman/stores-132.csv`) is the authority for which
 * branches exist, what they are called and which area each belongs to. It is
 * NOT the authority for managers — it has no such column — and the 122 rows
 * already in the CRM each carry an area and a chain manager that nothing else
 * records. So this UPDATES rather than replaces:
 *
 *   - branches in the file but not the CRM are created (blank managers);
 *   - the city of an existing branch is overwritten from the file;
 *   - managers and Yiji ids on existing branches are left alone;
 *   - nothing is ever deleted.
 *
 * A delete-and-reload would have been simpler to write and would have thrown
 * away all 122 manager pairs to gain nothing: every existing branch is already
 * in the file, and their names and Yiji ids match exactly.
 *
 * Dry run unless COMMIT=1:
 *
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node node_modules/vitest/vitest.mjs run \
 *       --config scripts/one-off/vitest.config.ts \
 *       scripts/one-off/apply-store-master.vitest.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const API = process.env.API ?? 'https://d2vi34f7wgjecb.cloudfront.net';
const CSV = process.env.CSV ?? 'Ayman/stores-132.csv';
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
  brand: { id: string; code: string | null; name: string | null } | null;
}
interface BrandRow {
  id: string;
  code: string | null;
  name: string | null;
}

/** One line of the operations list. */
interface FileRow {
  yijiId: string;
  code: string;
  name: string;
  brand: string;
  city: string;
}

function parse(csv: string): FileRow[] {
  return (
    csv
      // Strip the byte-order mark Excel writes. Built from a char code rather
      // than typed: as a character it is invisible in the source and lint
      // rejects it, and prettier rewrites an escaped one back to the literal.
      .replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '')
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => {
        const [yijiId, code, name, brand, city] = line.split(',');
        return {
          yijiId: (yijiId ?? '').trim(),
          code: (code ?? '').trim(),
          name: (name ?? '').trim(),
          brand: (brand ?? '').trim(),
          city: (city ?? '').trim(),
        };
      })
      .filter((r) => r.code)
  );
}

describe('apply the operations store list', () => {
  it('creates what is missing and corrects the areas', async () => {
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

    const rows = parse(readFileSync(CSV, 'utf8'));
    const stores = await get<StoreRow>(
      '/items/stores?limit=-1&fields=id,code,name,city,brand.id,brand.code,brand.name',
    );
    const brands = await get<BrandRow>('/items/brands?limit=-1&fields=id,code,name');

    /*
     * The file names brands in full ("Casa Pasta"); the CRM keys them by code
     * ("LCP") and only sometimes agrees on the display name. Matching on both
     * is what stops a new branch being created with no brand at all, which
     * would leave it unattributable in exactly the way this is fixing.
     */
    const brandBy = new Map<string, string>();
    for (const b of brands) {
      if (b.code) brandBy.set(b.code.trim().toLowerCase(), b.id);
      if (b.name) brandBy.set(b.name.trim().toLowerCase(), b.id);
    }

    const byCode = new Map(stores.map((s) => [(s.code ?? '').trim(), s]));

    const create: Array<Record<string, unknown>> = [];
    const recity: Array<{ id: string; code: string; from: string; to: string }> = [];
    const noBrand: string[] = [];

    for (const r of rows) {
      const brandId = brandBy.get(r.brand.toLowerCase());
      if (!brandId) noBrand.push(`${r.code} (${r.brand})`);

      const existing = byCode.get(r.code);
      if (!existing) {
        create.push({
          code: r.code,
          name: r.name,
          city: r.city,
          status: 'active',
          ...(brandId ? { brand: brandId } : {}),
          // The file's own Yiji id when it has one. Blank for a branch
          // operations have not yet mapped, which is honest.
          ...(r.yijiId ? { yiji_restaurant_id: r.yijiId } : {}),
        });
        continue;
      }
      if ((existing.city ?? '') !== r.city) {
        recity.push({ id: existing.id, code: r.code, from: existing.city ?? '', to: r.city });
      }
    }

    console.log(`file rows        : ${rows.length}`);
    console.log(`stores in CRM    : ${stores.length}`);
    console.log(`to CREATE        : ${create.length}`);
    for (const c of create) console.log(`   + ${c.code}  ${c.name}  [${c.city}]`);
    console.log(`city to CORRECT  : ${recity.length}`);
    console.log(
      `brand unresolved : ${noBrand.length}${noBrand.length ? ' -> ' + noBrand.join(', ') : ''}`,
    );
    expect(noBrand, 'every row must resolve to a brand').toHaveLength(0);

    if (!COMMIT) {
      console.log('\nDRY RUN — nothing written. Re-run with COMMIT=1.');
      return;
    }

    if (create.length) {
      const r = await fetch(`${API}/items/stores`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify(create),
      });
      if (!r.ok) throw new Error(`create: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
      console.log(`created ${create.length}`);
    }

    let done = 0;
    for (const u of recity) {
      const r = await fetch(`${API}/items/stores/${u.id}`, {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify({ city: u.to }),
      });
      if (!r.ok) {
        console.log(`   ! ${u.code}: HTTP ${r.status}`);
        continue;
      }
      done += 1;
    }
    console.log(`city corrected on ${done}/${recity.length}`);

    // ── what the master looks like afterwards ───────────────────────────
    const after = await get<StoreRow>('/items/stores?limit=-1&fields=id,code,city,brand.code');
    console.log(`\nstores now       : ${after.length}`);
    expect(after.length).toBe(rows.length);
    const stillMissing = rows.filter((r) => !after.some((s) => (s.code ?? '') === r.code));
    expect(stillMissing, 'a branch from the file did not land').toHaveLength(0);
  }, 900_000);
});
