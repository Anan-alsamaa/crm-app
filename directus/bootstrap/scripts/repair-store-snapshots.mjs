#!/usr/bin/env node
/**
 * Correct the branch attribution frozen onto tickets, where it was never true.
 *
 * NOT THE SAME JOB AS `backfill-store-snapshots.ts`. That one FILLS a missing
 * snapshot and deliberately never overwrites one, because a snapshot is meant
 * to be history and history is not editable. This one repairs snapshots that
 * are not history at all — they were written from a spreadsheet whose columns
 * were mis-mapped, and they have been wrong since the day they were captured.
 *
 * WHAT PROVES THAT, measured on the live database (56 tickets carry a snapshot):
 *
 *   54  wrong area manager   — 43 of them stamped "Mo'men Elsharkasy" across
 *                              branches whose masters name Jestoni Tejo, Ahmed
 *                              Nouh, Mostafa Alsayeed, Eslam Saeed and Moamen
 *                              Tag AlDin. Not one snapshot manager name even
 *                              EXISTS in the store master.
 *   50  wrong chain manager
 *   47  wrong city           — and this is the one that settles it. The values
 *                              are "Riyadh 1", "Khobar Area", "Hassa Area 2":
 *                              AREA labels, in the city field. A branch does
 *                              not move city, so a mismatch here cannot be
 *                              history — it is a mis-mapped column.
 *    0  wrong brand          — left alone; it was always right.
 *
 * The store master is authoritative and was independently confirmed against the
 * owner's own sheet on 2026-08-24: 122 of 122 rows agree on every field, with
 * the same three branches (LCP-019, LCP-020, LCP-041) carrying no Yiji id in
 * both. So repairing from the master is restoring the truth, not overwriting it.
 *
 * DELIBERATELY NOT TOUCHED:
 *   restaurantName — a mismatch here means the ticket may be linked to the
 *                    WRONG STORE, which is a different fault and not one a
 *                    script should paper over. Reported for a human instead.
 *   brandName      — already correct everywhere.
 *   via, capturedAt, backfilled — the provenance of the original capture.
 *
 * Every repaired snapshot gets `managersRepairedAt`, so a corrected row is
 * never mistaken for one that was right all along.
 *
 *   node scripts/repair-store-snapshots.mjs           # report only
 *   node scripts/repair-store-snapshots.mjs --write   # apply
 */
const WRITE = process.argv.includes('--write');

const DIRECTUS = process.env.DIRECTUS_INTERNAL_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

let token = '';

async function api(path, init = {}) {
  const res = await fetch(`${DIRECTUS}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : (await res.json()).data;
}

const norm = (v) => (v == null ? '' : String(v).trim());

async function main() {
  ({ access_token: token } = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }));

  const stores = await api(
    '/items/stores?limit=-1&fields=id,code,name,city,area_manager,chain_manager,brand.name',
  );
  const byId = new Map(stores.map((s) => [s.id, s]));

  const tickets = await api(
    '/items/tickets?limit=-1&fields=id,store,store_snapshot&filter[store][_nnull]=true',
  );

  const repairs = [];
  const misLinked = [];

  for (const t of tickets) {
    const snap = t.store_snapshot;
    if (!snap || typeof snap !== 'object') continue;
    const store = byId.get(t.store);
    if (!store) continue;

    const want = {
      city: norm(store.city),
      areaManager: norm(store.area_manager),
      chainManager: norm(store.chain_manager),
    };
    const changed = Object.entries(want).filter(([k, v]) => norm(snap[k]) !== v && v !== '');
    if (changed.length) {
      repairs.push({ id: t.id, code: store.code, changed, want });
    }

    /*
     * The snapshot names a branch, and the ticket points at a store. When those
     * disagree beyond formatting, one of them is wrong about which branch this
     * complaint was even about — a fault worth a person's judgement, not a
     * script's.
     */
    const snapName = norm(snap.restaurantName).toUpperCase();
    const masterName = `${norm(store.code)} ${norm(store.name)}`.toUpperCase();
    if (snapName && !snapName.includes(norm(store.name).toUpperCase()) && snapName !== masterName) {
      misLinked.push({ id: t.id, snapshot: norm(snap.restaurantName), store: masterName });
    }
  }

  console.log(`tickets with a resolved store : ${tickets.length}`);
  console.log(`snapshots needing repair      : ${repairs.length}`);
  const tally = {};
  for (const r of repairs) for (const [k] of r.changed) tally[k] = (tally[k] ?? 0) + 1;
  for (const [k, n] of Object.entries(tally)) console.log(`   ${k}: ${n}`);

  for (const r of repairs.slice(0, 8)) {
    console.log(
      `   ${r.code}: ` + r.changed.map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(', '),
    );
  }

  if (misLinked.length) {
    console.log(
      `\nPOSSIBLY LINKED TO THE WRONG BRANCH — not touched, needs a human: ${misLinked.length}`,
    );
    for (const m of misLinked.slice(0, 8)) {
      console.log(
        `   snapshot says ${m.snapshot !== '' ? m.snapshot : '(blank)'} · store is ${m.store}`,
      );
    }
  }

  if (!WRITE) {
    console.log('\nreport only — pass --write to apply.');
    return;
  }

  let done = 0;
  for (const r of repairs) {
    const t = tickets.find((x) => x.id === r.id);
    const next = {
      ...t.store_snapshot,
      ...r.want,
      // So a corrected row is never mistaken for one that was right all along.
      managersRepairedAt: new Date().toISOString(),
    };
    await api(`/items/tickets/${r.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ store_snapshot: next }),
    });
    done++;
  }
  console.log(`\nrepaired ${done} snapshot(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
