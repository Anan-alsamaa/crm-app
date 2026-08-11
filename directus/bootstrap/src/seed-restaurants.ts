/**
 * Restaurant master data seeder — brands + stores.
 *
 * TWO MODES:
 *
 *   pnpm --filter @yiji/directus-bootstrap seed:restaurants
 *     Seeds the brands, plus a SMALL starter set of stores. Deliberately not a
 *     transcription of the full operations sheet: that sheet was supplied as a
 *     screenshot, and ~200 branch names and cities read off a low-resolution
 *     image would contain errors that silently fail to match orders. Wrong
 *     master data is worse than none, because a mismatch looks like a blank
 *     cell rather than an error.
 *
 *   pnpm --filter @yiji/directus-bootstrap seed:restaurants -- stores.csv
 *     Loads the REAL sheet. Export it from Excel as CSV (or tab-delimited) with
 *     the columns: Restaurant, Area Manager, Chain Manager, Brand, City — and
 *     optionally "Yiji Restaurant ID". This is the intended path for real data;
 *     the same parser backs the Import CSV button in Restaurants -> Stores.
 *
 * Idempotent: rows are matched on (code, name) and updated rather than
 * duplicated, so re-running is safe.
 *
 * LOCAL DEMO ONLY unless you point it at a real Directus deliberately.
 */
import { readFileSync } from 'node:fs';

const DIRECTUS = process.env.DIRECTUS_INTERNAL_URL ?? 'http://localhost:8055';
const ADMIN_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const ADMIN_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

let TOKEN = '';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${DIRECTUS}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 400)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

interface BrandSeed {
  code: string;
  name: string;
  yiji_brand_name?: string;
}

/**
 * Brands. `code` is the label in the operations sheet's Brand column; `name` is
 * what the business actually calls the brand (confirmed by operations).
 *
 * `yiji_brand_name` matters where the ORDER SYSTEM spells it differently. Yiji
 * sends "La Casa Pasta" for what operations call "Casa Pasta" (verified on
 * order 946641), so without the alias a ticket at an unlisted Casa Pasta branch
 * would fall out of the brand ranking.
 *
 * Exactly the four brands operations run, with the codes their master file
 * uses. Confirmed against Yiji's own restaurant list, which spells them
 * Casa Pasta / Poshak / Okashi / Chick 'N' Dip against LCP / PSK / OKA / CND
 * codes.
 *
 * Only "CND Casual" appears in the master data — there is no CND Express, and
 * HD/MGA were dropped on 2026-08-11 as not being brands of this business. Do
 * NOT re-add any of them; a CSV import that contains a new brand still creates
 * it on demand, which is the right escape hatch.
 */
const BRANDS: BrandSeed[] = [
  { code: 'LCP', name: 'Casa Pasta', yiji_brand_name: 'La Casa Pasta' },
  { code: 'CND Casual', name: 'Chick N Dip' },
  { code: 'OKA', name: 'Okashi' },
  { code: 'PSK', name: 'Poshak' },
];

interface StoreSeed {
  code: string | null;
  name: string;
  city: string | null;
  area_manager: string | null;
  chain_manager: string | null;
  brandCode: string | null;
  yiji_restaurant_id?: string | null;
}

/**
 * Starter stores.
 *
 * "Masief Plaza" is the important one: it is the branch on the REAL order
 * already sitting in this database (946641 -> "Riyadh - Masief Plaza"), so
 * seeding it makes the existing demo ticket resolve end to end — brand, city
 * and managers appear in the ticket report and both dashboards immediately.
 * Its code is a placeholder; correct it from the real sheet.
 */
const STORES: StoreSeed[] = [
  {
    code: 'LCP-041',
    name: 'Masief Plaza',
    city: 'Riyadh',
    area_manager: 'Ahmed Samir',
    chain_manager: "Mo'men Elsharkawy",
    brandCode: 'LCP',
  },
  {
    code: 'LCP-002',
    name: 'Marina Mall 2',
    city: 'Dammam',
    area_manager: 'Medhat Saeed',
    chain_manager: "Mo'men Elsharkawy",
    brandCode: 'LCP',
  },
  {
    code: 'CND-001',
    name: 'Reine Plaza',
    city: 'Khobar',
    area_manager: 'Aly AbdulRahman',
    chain_manager: 'Aly AbdulRahman',
    brandCode: 'CND Express',
  },
  {
    code: 'CND-002',
    name: 'Buhairah Plaza',
    city: 'Khobar',
    area_manager: 'Aly AbdulRahman',
    chain_manager: 'Aly AbdulRahman',
    brandCode: 'CND Express',
  },
  {
    code: 'OKA-001',
    name: 'Gurnida Plaza',
    city: 'Dammam',
    area_manager: 'Mareoon Cruz',
    chain_manager: 'Mareoon Cruz',
    brandCode: 'OKA',
  },
  {
    code: 'PSK-001',
    name: 'Jubail Centro',
    city: 'Dammam',
    area_manager: 'Jamseer Jamal Kunnmanth',
    chain_manager: 'Fahad Moustafa',
    brandCode: 'PSK',
  },
];

/* ── CSV mode ─────────────────────────────────────────────────────────── */

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const HEADER: Record<string, keyof StoreSeed | 'brand'> = {
  restaurant: 'name',
  'restaurant name': 'name',
  store: 'name',
  name: 'name',
  city: 'city',
  'area manager': 'area_manager',
  area: 'area_manager',
  'chain manager': 'chain_manager',
  chain: 'chain_manager',
  brand: 'brand',
  code: 'code',
  'yiji restaurant id': 'yiji_restaurant_id',
  'restaurant id': 'yiji_restaurant_id',
};

function parseSheet(text: string): StoreSeed[] {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const tab = (lines[0]!.match(/\t/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0);
  const split = (l: string) => (tab ? l.split('\t').map((s) => s.trim()) : splitCsvLine(l));
  const header = split(lines[0]!).map((h) => HEADER[h.trim().toLowerCase()] ?? null);
  const rows: StoreSeed[] = [];
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const r: StoreSeed = {
      code: null,
      name: '',
      city: null,
      area_manager: null,
      chain_manager: null,
      brandCode: null,
    };
    header.forEach((key, i) => {
      const v = (cells[i] ?? '').trim();
      if (!key || !v) return;
      if (key === 'brand') r.brandCode = v;
      else if (key === 'name') r.name = v;
      else if (key === 'code') r.code = v;
      else if (key === 'city') r.city = v;
      else if (key === 'area_manager') r.area_manager = v;
      else if (key === 'chain_manager') r.chain_manager = v;
      else if (key === 'yiji_restaurant_id') r.yiji_restaurant_id = v;
    });
    if (!r.name) continue;
    if (!r.code) {
      const m = /^([A-Za-z]{2,6}[-\s]?\d{1,4})\s+(.*)$/.exec(r.name);
      if (m && m[2]) {
        r.code = m[1]!.trim();
        r.name = m[2].trim();
      }
    }
    rows.push(r);
  }
  return rows;
}

/* ── Run ──────────────────────────────────────────────────────────────── */

async function main() {
  const csvPath = process.argv[2];

  const auth = await api<{ data: { access_token: string } }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  TOKEN = auth.data.access_token;

  const stores = csvPath ? parseSheet(readFileSync(csvPath, 'utf8')) : STORES;
  if (csvPath) console.log(`Loaded ${stores.length} stores from ${csvPath}`);
  else console.log(`Seeding ${stores.length} starter stores (pass a CSV path for the full sheet)`);

  // Brands referenced by the data, on top of the known list, so a CSV with a
  // brand we have never seen still imports rather than silently losing it.
  const wanted = new Map(BRANDS.map((b) => [b.code.toLowerCase(), b]));
  for (const s of stores) {
    if (s.brandCode && !wanted.has(s.brandCode.toLowerCase()))
      wanted.set(s.brandCode.toLowerCase(), { code: s.brandCode, name: s.brandCode });
  }

  const existingBrands = await api<{ data: Array<{ id: string; code: string }> }>(
    '/items/brands?limit=-1&fields=id,code',
  );
  const brandId = new Map(existingBrands.data.map((b) => [b.code.trim().toLowerCase(), b.id]));

  let brandsCreated = 0;
  let brandsUpdated = 0;
  for (const b of wanted.values()) {
    const key = b.code.trim().toLowerCase();
    const body = {
      code: b.code,
      name: b.name,
      yiji_brand_name: b.yiji_brand_name ?? null,
      status: 'active',
    };
    const hit = brandId.get(key);
    if (hit) {
      // UPSERT, not create-if-absent: brand names get corrected (a code stays
      // put while the display name changes), and a seeder that only ever
      // inserts would leave the old wording in place with no sign of it.
      await api(`/items/brands/${hit}`, { method: 'PATCH', body: JSON.stringify(body) });
      brandsUpdated++;
      continue;
    }
    const created = await api<{ data: { id: string } }>('/items/brands', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    brandId.set(key, created.data.id);
    brandsCreated++;
  }

  const existingStores = await api<{
    data: Array<{ id: string; code: string | null; name: string }>;
  }>('/items/stores?limit=-1&fields=id,code,name');
  const storeKey = (code: string | null, name: string) =>
    `${(code ?? '').trim().toLowerCase()}|${name.trim().toLowerCase()}`;
  const existing = new Map(existingStores.data.map((s) => [storeKey(s.code, s.name), s.id]));

  let created = 0;
  let updated = 0;
  for (const s of stores) {
    const payload = {
      code: s.code,
      name: s.name,
      city: s.city,
      area_manager: s.area_manager,
      chain_manager: s.chain_manager,
      yiji_restaurant_id: s.yiji_restaurant_id ?? null,
      brand: s.brandCode ? (brandId.get(s.brandCode.trim().toLowerCase()) ?? null) : null,
      status: 'active',
    };
    const hit = existing.get(storeKey(s.code, s.name));
    if (hit) {
      await api(`/items/stores/${hit}`, { method: 'PATCH', body: JSON.stringify(payload) });
      updated++;
    } else {
      await api('/items/stores', { method: 'POST', body: JSON.stringify(payload) });
      created++;
    }
  }

  console.log(
    `Done. brands: +${brandsCreated} created, ${brandsUpdated} updated (${wanted.size} total) · ` +
      `stores: +${created} created, ${updated} updated`,
  );
  if (!csvPath) {
    console.log(
      'Starter data only. Export the operations sheet as CSV and re-run with its path,\n' +
        'or use Restaurants -> Stores -> Import CSV in the admin portal.',
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
