/*
 * The VENDOR row — the tenant every conversation, contact and ticket belongs to.
 *
 * Missed when stores and brands were copied, and the failure was well disguised:
 * the walk-in endpoint answered 404 "unknown or inactive vendor", which reads
 * like a missing ROUTE, so the first instinct is to inspect load balancer rules
 * and the deployed image. Both were correct. The row simply did not exist.
 *
 * `yiji_vendor_id` is what the widget's token names, so it must match staging's
 * exactly or a token minted for the customer resolves to nothing.
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
  const H = {
    Authorization: `Bearer ${login.data.access_token}`,
    'Content-Type': 'application/json',
  };
  return {
    get: async (p) => (await fetch(`${api}${p}`, { headers: H }).then((x) => x.json())).data ?? [],
    post: async (p, b) => {
      const r = await fetch(`${api}${p}`, { method: 'POST', headers: H, body: JSON.stringify(b) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(`${p}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 250)}`);
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

const sv = await stg.get(
  '/items/vendors?limit=-1&fields=yiji_vendor_id,name,status,colors,support_settings,logo',
);
const pv = await prd.get('/items/vendors?limit=-1&fields=yiji_vendor_id,name');
console.log(
  `staging vendors:    ${sv.map((v) => `${v.name} (${v.yiji_vendor_id}, ${v.status})`).join(', ') || 'none'}`,
);
console.log(
  `production vendors: ${pv.map((v) => `${v.name} (${v.yiji_vendor_id})`).join(', ') || 'NONE — this is the bug'}`,
);

const have = new Set(pv.map((v) => String(v.yiji_vendor_id)));
const missing = sv.filter((v) => !have.has(String(v.yiji_vendor_id)));
console.log(`\nto copy: ${missing.length}`);
if (!APPLY) {
  console.log('DRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}
for (const v of missing) {
  const made = await prd.post('/items/vendors', {
    yiji_vendor_id: v.yiji_vendor_id,
    name: v.name,
    status: v.status ?? 'active',
    colors: v.colors ?? null,
    ...(v.support_settings ? { support_settings: v.support_settings } : {}),
  });
  console.log(`  created ${made.name} (yiji_vendor_id=${made.yiji_vendor_id})`);
}
