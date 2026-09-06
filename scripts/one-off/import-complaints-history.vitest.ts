/**
 * Load the historical complaints sheet into a deployed environment.
 *
 * NOT a test — a one-shot loader that happens to run under Vitest, because
 * Vitest is the only TypeScript runner on this machine and the alternative is
 * a second copy of the CSV→ticket mapping. It imports the SAME functions the
 * portal's import button uses, so a row loaded here and a row loaded there
 * describe the same complaint identically.
 *
 * Dry run unless COMMIT=1. It needs its own config, because the root one
 * deliberately does not collect this directory:
 *
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node node_modules/vitest/vitest.mjs run --config scripts/one-off/vitest.config.ts
 *
 * Add COMMIT=1 to write, LIMIT=n to load only the first n rows, CSV=… for a
 * different sheet and API=… for a different environment.
 *
 * Idempotent. A row is identified by complaint instant + order number + the
 * opening of its description, rebuilt from what is already stored, and rows
 * that match something present are skipped — so a partial load can simply be
 * re-run rather than duplicating what landed.
 */
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTicketsCsv, ticketPayloadFromCsvRow, toComplaintDate } from '@yiji/reports';
import { buildStoreIndex, matchStore, normalizePhone, type StoreRecord } from '@yiji/shared-types';

const API = process.env.API ?? 'https://d2vi34f7wgjecb.cloudfront.net';
const CSV =
  process.env.CSV ??
  'd:/emad/Afcoapp/ProgramFile/claudeCode/crm-app/Ayman/Complaints_History_Import.csv';
const EMAIL = process.env.ADMIN_EMAIL ?? '';
const PASS = process.env.ADMIN_PASSWORD ?? '';
const COMMIT = process.env.COMMIT === '1';
const LIMIT = Number(process.env.LIMIT ?? '0');

describe('import historical complaints', () => {
  it('loads the sheet', async () => {
    if (!EMAIL || !PASS) throw new Error('set ADMIN_EMAIL and ADMIN_PASSWORD');

    /*
     * Directus answers every collection with `{ data }` and every refusal with
     * `{ errors }`. The rows are typed per query rather than as a blanket
     * `any`, so a renamed column is a compile error here and not a silently
     * empty column in the report.
     */
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
      complaint_date: string | null;
      order_id: string | null;
      description: string | null;
      count?: number;
    }
    interface ContactRow {
      id: string;
      phone: string | null;
    }
    interface UserRow {
      id: string;
      first_name: string | null;
    }
    interface IdRow {
      id: string;
    }

    const login = (await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then((r) => r.json())) as Envelope<{ access_token?: string }>;
    if (!login?.data?.access_token) throw new Error('login failed');
    const H = {
      Authorization: `Bearer ${login.data.access_token}`,
      'Content-Type': 'application/json',
    };

    const get = async <T>(p: string): Promise<T[]> => {
      const r = (await fetch(`${API}${p}`, { headers: H }).then((x) => x.json())) as Envelope<T[]>;
      if (r.errors) throw new Error(`${p}: ${JSON.stringify(r.errors).slice(0, 200)}`);
      return r.data ?? [];
    };

    // ── the sheet ────────────────────────────────────────────────────────
    const parsed = parseTicketsCsv(readFileSync(CSV, 'utf8'));
    console.log(`\nsheet: ${parsed.rows.length} rows, ${parsed.skipped.length} skipped`);
    if (parsed.unmappedHeaders.length)
      console.log(`  UNMAPPED HEADERS: ${parsed.unmappedHeaders.join(', ')}`);

    // ── the store master, for branch/brand/area attribution ──────────────
    // `brand` is a relation, not columns on the store — expand it, or every
    // row loses its brand and the breakdown's brand cut comes out empty.
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
    console.log(`stores: ${stores.length}`);

    // ── what is already loaded ───────────────────────────────────────────
    /*
     * There is no `external_ref` column on tickets, so identity comes from
     * what IS stored: the complaint instant, the order number and the opening
     * of the description. That triple is what distinguishes two complaints in
     * the sheet, and it survives a re-run — which is what makes a partial load
     * safe to repeat instead of duplicating everything that already landed.
     */
    const identity = (complaintDate: string | null, orderId: string, description: string): string =>
      `${complaintDate ?? ''}|${orderId}|${description.slice(0, 60)}`;

    const existing = await get<TicketRow>(
      '/items/tickets?limit=-1&fields=id,complaint_date,order_id,description',
    );
    const haveRef = new Set(
      existing.map((t) =>
        identity(t.complaint_date ?? null, String(t.order_id ?? ''), String(t.description ?? '')),
      ),
    );
    console.log(`tickets already present: ${existing.length}`);

    // Contacts, so a repeat complainer is one customer rather than many.
    const contactRows = await get<ContactRow>('/items/contacts?limit=-1&fields=id,phone');
    const contactByPhone = new Map<string, string>();
    for (const c of contactRows) if (c.phone) contactByPhone.set(String(c.phone), c.id);

    // Agents named in the sheet → Directus users, matched on first name.
    const users = await get<UserRow>('/users?limit=-1&fields=id,first_name,last_name,email');
    const userByName = new Map<string, string>();
    for (const u of users) {
      const n = String(u.first_name ?? '')
        .trim()
        .toLowerCase();
      if (n && !userByName.has(n)) userByName.set(n, u.id);
    }

    const vendorRows = await get<IdRow>('/items/vendors?limit=1&fields=id');
    const vendorId = vendorRows[0]?.id ?? null;

    // ── plan ─────────────────────────────────────────────────────────────
    const capturedAt = new Date().toISOString();
    const via: Record<string, number> = {};
    let skippedExisting = 0;
    let noDate = 0;
    let badPhone = 0;
    const plan: Array<{
      ref: string;
      phone: string | null;
      payload: Record<string, unknown>;
    }> = [];

    for (const row of parsed.rows) {
      const complaintDate = toComplaintDate(row.date, row.time);
      if (!complaintDate) noDate++;

      const ref = identity(
        complaintDate,
        String(row.orderNumber ?? ''),
        String(row.complaintDescription ?? ''),
      );
      if (haveRef.has(ref)) {
        skippedExisting++;
        continue;
      }
      // Guard against duplicates WITHIN the sheet as well as against the DB.
      haveRef.add(ref);

      const match = matchStore(index, {
        restaurantName: row.restaurantName ?? null,
        brandName: row.brand ?? null,
      });
      via[match.via] = (via[match.via] ?? 0) + 1;

      /*
       * The canonical stored form is 05XXXXXXXX and 1,672 of the 1,673 rows
       * already are. The one that is not is an 18-digit paste that
       * `normalizePhone` passes through untouched — it cannot tell a corrupt
       * number from an unfamiliar one. Loading it would mint a contact with a
       * phone nobody can ever dial or match. The complaint is still real, so
       * the TICKET loads; only the customer link is withheld.
       */
      const raw = row.customerMobile ? normalizePhone(row.customerMobile) : null;
      const phone = raw && /^05\d{8}$/.test(raw) ? raw : null;
      if (raw && !phone) badPhone++;
      const agentId =
        userByName.get(
          String(row.agent ?? '')
            .trim()
            .toLowerCase(),
        ) ?? null;

      const payload = ticketPayloadFromCsvRow(row, {
        store: match,
        contactId: phone ? (contactByPhone.get(phone) ?? null) : null,
        vendorId,
        agentId,
        complaintDate,
        capturedAt,
      });
      // Persist the order number so the identity key above can be rebuilt on
      // a re-run. The sheet's order_number is the only stable handle a row has.
      if (row.orderNumber) payload.order_id = String(row.orderNumber).trim();

      plan.push({ ref, phone, payload });
      if (LIMIT && plan.length >= LIMIT) break;
    }

    console.log(`\nto insert: ${plan.length}`);
    console.log(`  already loaded (skipped): ${skippedExisting}`);
    console.log(`  unusable date: ${noDate}`);
    console.log(`  unusable phone (no contact linked): ${badPhone}`);
    console.log('  store attribution:');
    for (const [k, n] of Object.entries(via).sort((a, b) => b[1] - a[1]))
      console.log(`    ${k.padEnd(18)} ${n}`);
    const needContact = plan.filter((p) => p.phone && !contactByPhone.has(p.phone)).length;
    console.log(`  new contacts needed: ${needContact}`);

    if (!COMMIT) {
      console.log('\nDRY RUN — nothing written. Re-run with COMMIT=1.\n');
      return;
    }

    // ── contacts first: a ticket references one ──────────────────────────
    const missing = [
      ...new Set(plan.filter((p) => p.phone && !contactByPhone.has(p.phone)).map((p) => p.phone!)),
    ];
    console.log(`\ncreating ${missing.length} contacts`);
    for (let i = 0; i < missing.length; i += 50) {
      /*
       * Phone only, with no name. The sheet HAS a `customer_name` column and it
       * is empty in all 1,673 rows — it is also not one of the report's
       * columns, so `parseTicketsCsv` does not even carry it. A contact with a
       * null name is the honest record of what the sheet knows; inventing a
       * placeholder would make the contact list look populated and be worthless.
       */
      const batch = missing.slice(i, i + 50).map((phone) => ({
        phone,
        name: null,
        ...(vendorId ? { vendor: vendorId } : {}),
      }));
      const r = await fetch(`${API}/items/contacts`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify(batch),
      });
      if (!r.ok) {
        console.log(`  contacts batch failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
        continue;
      }
      for (const c of ((await r.json()) as Envelope<ContactRow[]>).data ?? [])
        contactByPhone.set(String(c.phone), c.id);
      process.stdout.write(`\r  contacts: ${contactByPhone.size}`);
    }
    process.stdout.write('\n');

    // Re-resolve now that the contacts exist.
    for (const p of plan)
      if (p.phone && contactByPhone.has(p.phone)) p.payload.contact = contactByPhone.get(p.phone);

    // ── tickets ──────────────────────────────────────────────────────────
    let done = 0;
    const failures: string[] = [];
    for (let i = 0; i < plan.length; i += 50) {
      const batch = plan.slice(i, i + 50).map((p) => p.payload);
      const r = await fetch(`${API}/items/tickets`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify(batch),
      });
      if (r.ok) {
        done += batch.length;
      } else {
        // One bad row must not cost the other 49.
        const why = (await r.text()).slice(0, 200);
        for (const p of plan.slice(i, i + 50)) {
          const one = await fetch(`${API}/items/tickets`, {
            method: 'POST',
            headers: H,
            body: JSON.stringify([p.payload]),
          });
          if (one.ok) done += 1;
          else failures.push(`${p.ref}: ${(await one.text()).slice(0, 120)}`);
        }
        if (failures.length && failures.length <= 3) console.log(`\n  batch fell back: ${why}`);
      }
      process.stdout.write(`\r  tickets: ${done}/${plan.length}`);
    }
    process.stdout.write('\n');

    if (failures.length) {
      console.log(`\n${failures.length} rows failed:`);
      for (const f of failures.slice(0, 10)) console.log(`  ${f}`);
    }

    const after = await get<TicketRow>('/items/tickets?aggregate[count]=*');
    console.log(`\ntickets now: ${after[0]?.count ?? '?'}`);
  }, 1_800_000);
});
