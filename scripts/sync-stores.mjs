/**
 * Make `stores` match an operations spreadsheet EXACTLY — including removals.
 *
 *   node scripts/sync-stores.mjs <file.xlsx|file.csv>            # dry run
 *   node scripts/sync-stores.mjs <file.xlsx|file.csv> --write    # apply
 *
 * Columns (header row, any order): Restaurant ID, Code, Store, Brand, City,
 * Chain Manger, Area Manger — the operations sheet's own spelling.
 *
 * Distinct from the Stores page's "Import CSV", which only adds and updates.
 * When ops send a FINAL list, branches missing from it have to go too, and that
 * is the part worth doing carefully:
 *
 *   - Rows are matched to existing branches by Yiji restaurant id, then by
 *     code, and UPDATED IN PLACE so a branch keeps its uuid — and with it every
 *     ticket pointing at it. A delete-all-then-reinsert would null
 *     `tickets.store` on every historical ticket (the FK is ON DELETE SET NULL).
 *   - A blank Restaurant ID means "not supplied", never "erase the one we
 *     have". Clearing it would break the automatic order→branch match that
 *     column exists for.
 *   - Before deleting, it reports how many tickets each doomed branch carries.
 *     `store_snapshot` on a ticket is frozen, so reports survive the delete,
 *     but the live link does not — so the count is stated rather than assumed
 *     harmless.
 *
 * Goes through Directus, not SQL, so revisions and date_updated behave.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FILE = args.find((a) => !a.startsWith('--'));
if (!FILE) {
  console.error('usage: node scripts/sync-stores.mjs <file.xlsx|file.csv> [--write]');
  process.exit(1);
}

/* ── reading the sheet ─────────────────────────────────────────────── */

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');

/** An xlsx is zipped XML; unzip with the platform's own tool, no dependency. */
function readXlsx(path) {
  const dir = mkdtempSync(join(tmpdir(), 'stores-'));
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${path}' -DestinationPath '${dir}' -Force`,
      ],
      { stdio: 'ignore' },
    );
  } catch {
    execFileSync('unzip', ['-o', '-q', path, '-d', dir], { stdio: 'ignore' });
  }
  const shared = [
    ...readFileSync(join(dir, 'xl/sharedStrings.xml'), 'utf8').matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) =>
    unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const sheet = readFileSync(join(dir, 'xl/worksheets/sheet1.xml'), 'utf8');
  const colOf = (ref) => {
    let n = 0;
    for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const rows = [];
  for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*)\/?>(?:([\s\S]*?)<\/c>)?/g)) {
      const [, ref, attrs, body = ''] = cm;
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      const t = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      cells[colOf(ref)] = /t="s"/.test(attrs)
        ? (shared[+(v?.[1] ?? -1)] ?? '')
        : /t="(inlineStr|str)"/.test(attrs)
          ? t
            ? unescapeXml(t[1])
            : ''
          : unescapeXml(v?.[1] ?? '');
    }
    rows.push(Array.from(cells, (c) => (c ?? '').trim()));
  }
  return rows.filter((r) => r.some(Boolean));
}

/** Minimal CSV: quoted fields with doubled quotes, commas and newlines inside. */
function readCsv(path) {
  // Excel writes a UTF-8 BOM; strip it by code point rather than by matching
  // the literal character, which would put invisible whitespace in the source.
  const raw = readFileSync(path, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field.trim());
      field = '';
    } else if (c === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some(Boolean));
}

// The extension lies sometimes (ops export .xlsx named .csv), so sniff the
// ZIP magic instead of trusting it.
const isZip = readFileSync(FILE).subarray(0, 2).toString('binary') === 'PK';
const [header, ...data] = isZip ? readXlsx(FILE) : readCsv(FILE);

const col = (name) => {
  const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  if (i === -1) throw new Error(`column "${name}" not found in: ${header.join(', ')}`);
  return i;
};
const C = {
  rid: col('Restaurant ID'),
  code: col('Code'),
  name: col('Store'),
  brand: col('Brand'),
  city: col('City'),
  chain: col('Chain Manger'),
  area: col('Area Manger'),
};
const incoming = data.map((r) => ({
  yiji_restaurant_id: r[C.rid] ?? '',
  code: r[C.code] ?? '',
  name: r[C.name] ?? '',
  brandName: r[C.brand] ?? '',
  city: r[C.city] ?? '',
  chain_manager: r[C.chain] ?? '',
  area_manager: r[C.area] ?? '',
}));

const dup = (key) => {
  const seen = new Map();
  for (const s of incoming) if (s[key]) seen.set(s[key], (seen.get(s[key]) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([v]) => v);
};
for (const key of ['yiji_restaurant_id', 'code']) {
  const d = dup(key);
  if (d.length) throw new Error(`the sheet repeats ${key}: ${d.join(', ')} — refusing to guess`);
}

/* ── syncing ───────────────────────────────────────────────────────── */

const login = await fetch(`${D}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: process.env.DIRECTUS_ADMIN_EMAIL,
    password: process.env.DIRECTUS_ADMIN_PASSWORD,
  }),
});
if (!login.ok) throw new Error(`Directus login failed (${login.status})`);
const AT = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };
const api = async (method, path, body) => {
  const res = await fetch(`${D}${path}`, {
    method,
    headers: H,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : (await res.json()).data;
};

const brands = await api('GET', '/items/brands?fields=id,name&limit=-1');
const brandId = new Map(brands.map((b) => [b.name.trim().toLowerCase(), b.id]));
const unknown = [...new Set(incoming.map((s) => s.brandName))].filter(
  (b) => !brandId.has(b.toLowerCase()),
);
if (unknown.length)
  throw new Error(`brands not in the CRM: ${unknown.join(', ')} — add them first`);

const current = await api(
  'GET',
  '/items/stores?fields=id,code,name,city,area_manager,chain_manager,yiji_restaurant_id,status,brand&limit=-1',
);
const byRid = new Map(
  current.filter((c) => c.yiji_restaurant_id).map((c) => [c.yiji_restaurant_id, c]),
);
const byCode = new Map(current.filter((c) => c.code).map((c) => [c.code, c]));

let updated = 0;
let unchanged = 0;
let created = 0;
const kept = new Set();

for (const s of incoming) {
  const hit = byRid.get(s.yiji_restaurant_id) || byCode.get(s.code);
  const want = {
    code: s.code || null,
    name: s.name,
    city: s.city || null,
    area_manager: s.area_manager || null,
    chain_manager: s.chain_manager || null,
    brand: brandId.get(s.brandName.toLowerCase()),
    status: 'active',
    ...(s.yiji_restaurant_id ? { yiji_restaurant_id: s.yiji_restaurant_id } : {}),
  };
  if (!hit) {
    console.log(`+ create  ${s.code}  ${s.name}`);
    if (WRITE) await api('POST', '/items/stores', want);
    created++;
    continue;
  }
  kept.add(hit.id);
  const patch = Object.fromEntries(
    Object.entries(want).filter(([k, v]) => (hit[k] ?? null) !== (v ?? null)),
  );
  if (!Object.keys(patch).length) {
    unchanged++;
    continue;
  }
  console.log(`~ update  ${s.code}  ${s.name}  ${JSON.stringify(patch)}`);
  if (WRITE) await api('PATCH', `/items/stores/${hit.id}`, patch);
  updated++;
}

const removed = current.filter((c) => !kept.has(c.id));
for (const r of removed) {
  // Say what the delete costs BEFORE doing it: the frozen store_snapshot keeps
  // reports honest, but these tickets lose their live branch link.
  const [{ count }] = await api(
    'GET',
    `/items/tickets?aggregate[count]=id&filter[store][_eq]=${r.id}`,
  );
  const n = Number(count.id ?? count) || 0;
  console.log(
    `- delete  ${r.code ?? '—'}  ${r.name}${n ? `   (${n} ticket(s) lose their branch link)` : ''}`,
  );
  if (WRITE) await api('DELETE', `/items/stores/${r.id}`);
}

console.log(
  `\n${WRITE ? 'APPLIED' : 'DRY RUN'} — updated ${updated}, unchanged ${unchanged}, created ${created}, deleted ${removed.length}`,
);
if (WRITE) {
  const [{ count }] = await api('GET', '/items/stores?aggregate[count]=id');
  console.log('stores now:', count.id ?? count);
}
