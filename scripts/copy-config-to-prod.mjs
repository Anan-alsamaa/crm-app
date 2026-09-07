/**
 * Copy the CONFIGURATION staging has and production lacks.
 *
 *   node scripts/copy-config-to-prod.mjs           # dry run
 *   node scripts/copy-config-to-prod.mjs --apply   # write it
 *
 * Reference data (vendor, brands, stores) is handled by
 * copy-reference-data.mjs and copy-vendor.mjs. This is the operational
 * configuration a CRM needs before anyone can work in it:
 *
 *   sla_policies   — without these NOTHING is measured against a deadline,
 *                    so every ticket looks fine for ever.
 *   teams          — how tickets are routed and assigned.
 *   quick_replies  — the canned answers agents actually use.
 *   tags           — the labels they file things under.
 *
 * NOT A BLIND COPY. Staging is a test environment and carries the debris to
 * prove it: 81 of its 83 teams are named "QA Team <timestamp>", created by
 * automated runs. Copying those would hand a brand-new production system 81
 * meaningless routing targets that somebody would then have to delete one at
 * a time. Only real configuration crosses.
 *
 * Idempotent, matching on the field a human would recognise (name or label),
 * so it can be re-run after the production database moves.
 */
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const STAGING = 'https://d2vi34f7wgjecb.cloudfront.net';
const PROD = 'https://d2ljjkmk6p5y4b.cloudfront.net';

/**
 * Rows that exist because a TEST created them, never because someone decided
 * production should have them.
 */
const isTestResidue = (row) =>
  /^(QA|E2E|Probe|ZZPROBE|Test)\b/i.test(String(row.name ?? row.label ?? ''));

/** What to copy, and how to tell two rows apart. */
const COLLECTIONS = [
  {
    name: 'sla_policies',
    key: 'name',
    fields: [
      'name',
      'description',
      'applies_to_priority',
      'applies_to_type',
      'applies_to_source',
      'applies_to_brand',
      'first_response_minutes',
      'resolution_minutes',
      'warning_threshold_percent',
      'business_hours',
      'response_hours',
      'resolution_hours',
      'governs',
      'active',
    ],
  },
  { name: 'teams', key: 'name', fields: ['name', 'description'] },
  { name: 'quick_replies', key: 'label', fields: ['label', 'text'] },
  { name: 'tags', key: 'name', fields: ['name', 'color'] },
];

function envOf(file) {
  return Object.fromEntries(
    readFileSync(`${ROOT}/${file}`, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

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
        throw new Error(`${p}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 250)}`);
      return j.data;
    },
  };
}

const s = envOf('.env');
const p = envOf('.env.prod.aws');
const stg = await connect(STAGING, s.DIRECTUS_ADMIN_EMAIL, s.DIRECTUS_ADMIN_PASSWORD);
const prd = await connect(PROD, p.DIRECTUS_ADMIN_EMAIL, p.DIRECTUS_ADMIN_PASSWORD);

for (const c of COLLECTIONS) {
  const rows = await stg.get(`/items/${c.name}?limit=-1&fields=${c.fields.join(',')}`);
  const mine = await prd.get(`/items/${c.name}?limit=-1&fields=${c.key}`);
  const have = new Set(mine.map((r) => r[c.key]));

  const residue = rows.filter(isTestResidue);
  const real = rows.filter((r) => !isTestResidue(r));
  const todo = real.filter((r) => !have.has(r[c.key]));

  console.log(
    `${c.name.padEnd(16)} staging ${String(rows.length).padStart(3)}` +
      `  (${residue.length} test residue skipped)` +
      `  production ${String(mine.length).padStart(3)}  to copy ${todo.length}`,
  );
  for (const r of todo) console.log(`    + ${r[c.key]}`);

  if (!APPLY || !todo.length) continue;
  await prd.post(
    `/items/${c.name}`,
    todo.map((r) => Object.fromEntries(c.fields.map((f) => [f, r[f] ?? null]))),
  );
  console.log(`    copied ${todo.length}`);
}

console.log(APPLY ? '\nDone.' : '\nDRY RUN — nothing written. Re-run with --apply.');
