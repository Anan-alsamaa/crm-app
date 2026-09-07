/*
 * Copy BRANDS and STORES from staging into production.
 *
 * Reference data, not test data: the 133 branches and their brands are the
 * same real-world facts in both environments, and a ticket cannot be
 * attributed to a branch that does not exist. Everything else — tickets,
 * contacts, conversations — stays behind, because production starts empty.
 *
 * Brands go first: a store names its brand, so the brand must already exist.
 * Idempotent by CODE, so a re-run after the database moves adds only what is
 * missing.
 */
import { readFileSync } from 'node:fs';
const APPLY = process.argv.includes('--apply');
const ROOT = 'd:/emad/Afcoapp/ProgramFile/claudeCode/crm-app';
const envOf = (f) =>
  Object.fromEntries(
    readFileSync(`${ROOT}/${f}`, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );

async function connect(api, email, password) {
  const login = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  if (!login?.data?.access_token) throw new Error(`${api}: login failed`);
  const H = {
    Authorization: `Bearer ${login.data.access_token}`,
    'Content-Type': 'application/json',
  };
  return {
    get: async (p) => {
      const r = await fetch(`${api}${p}`, { headers: H }).then((x) => x.json());
      if (r.errors) throw new Error(`${p}: ${JSON.stringify(r.errors).slice(0, 200)}`);
      return r.data ?? [];
    },
    post: async (p, body) => {
      const r = await fetch(`${api}${p}`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(`${p}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
      return j.data;
    },
  };
}

const s = envOf('.env'),
  p = envOf('.env.prod.aws');
const stg = await connect(
  'https://d2vi34f7wgjecb.cloudfront.net',
  s.DIRECTUS_ADMIN_EMAIL,
  s.DIRECTUS_ADMIN_PASSWORD,
);
const prd = await connect(
  'https://d2ljjkmk6p5y4b.cloudfront.net',
  p.DIRECTUS_ADMIN_EMAIL,
  p.DIRECTUS_ADMIN_PASSWORD,
);

// ── brands ──────────────────────────────────────────────────────────────
const sBrands = await stg.get('/items/brands?limit=-1&fields=code,name,yiji_brand_name,status');
const pBrands = await prd.get('/items/brands?limit=-1&fields=id,code');
const haveBrand = new Map(pBrands.map((b) => [b.code, b.id]));
const newBrands = sBrands.filter((b) => !haveBrand.has(b.code));
console.log(
  `brands   staging ${sBrands.length}   production ${pBrands.length}   to add ${newBrands.length}`,
);
if (APPLY && newBrands.length) {
  const made = await prd.post(
    '/items/brands',
    newBrands.map((b) => ({
      code: b.code,
      name: b.name,
      yiji_brand_name: b.yiji_brand_name ?? null,
      status: b.status ?? 'active',
    })),
  );
  for (const b of [].concat(made)) haveBrand.set(b.code, b.id);
  console.log(`  created ${[].concat(made).length}`);
}

// ── stores ──────────────────────────────────────────────────────────────
const sStores = await stg.get(
  '/items/stores?limit=-1&fields=code,name,city,area_manager,chain_manager,yiji_restaurant_id,status,brand.code',
);
const pStores = await prd.get('/items/stores?limit=-1&fields=code');
const haveStore = new Set(pStores.map((x) => x.code));
const newStores = sStores.filter((x) => !haveStore.has(x.code));
console.log(
  `stores   staging ${sStores.length}   production ${pStores.length}   to add ${newStores.length}`,
);

const orphan = newStores.filter((x) => x.brand?.code && !haveBrand.has(x.brand.code));
if (orphan.length) console.log(`  WARNING ${orphan.length} store(s) name a brand production lacks`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}
if (newStores.length) {
  // In batches: 133 rows in one request is a large body for the CDN in front.
  for (let i = 0; i < newStores.length; i += 40) {
    const batch = newStores.slice(i, i + 40).map((x) => ({
      code: x.code,
      name: x.name,
      city: x.city ?? null,
      area_manager: x.area_manager ?? null,
      chain_manager: x.chain_manager ?? null,
      yiji_restaurant_id: x.yiji_restaurant_id ?? null,
      status: x.status ?? 'active',
      ...(x.brand?.code && haveBrand.has(x.brand.code)
        ? { brand: haveBrand.get(x.brand.code) }
        : {}),
    }));
    await prd.post('/items/stores', batch);
    console.log(`  created ${i + batch.length}/${newStores.length}`);
  }
}
const after = await prd.get('/items/stores?limit=-1&fields=code');
console.log(
  `\nproduction now: ${(await prd.get('/items/brands?limit=-1&fields=code')).length} brands, ${after.length} stores`,
);
