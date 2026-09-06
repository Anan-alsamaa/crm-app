/**
 * Prove the Import button's REAL code path against deployed staging.
 *
 * The unit tests mock the writes, so they prove the planning and not the
 * permissions — and permissions are where this feature can actually fail: the
 * button is offered on a privilege (`import_data`) while Directus enforces a
 * separate policy, and the two can disagree. So this signs in as a WeCare
 * Admin, runs the same `planImport`/`runImport` the dialog runs, and deletes
 * everything it made.
 *
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node node_modules/vitest/vitest.mjs run \
 *       --config scripts/one-off/vitest.config.ts \
 *       scripts/one-off/verify-import-ui.vitest.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTicketsCsv } from '@yiji/reports';
import { buildStoreIndex, type StoreRecord } from '@yiji/shared-types';
import {
  planImport,
  runImport,
  ticketIdentity,
} from '../../apps/admin-portal/src/features/report-exports/import-tickets.js';

const API = process.env.API ?? 'https://d2vi34f7wgjecb.cloudfront.net';
const CSV = process.env.CSV ?? 'C:/Users/E79FE~1.HAB/AppData/Local/Temp/import-probe.csv';
// A WeCare Admin on purpose, NOT the owner: the point is that the role holding
// import_data can actually write, not that an administrator can.
const EMAIL = process.env.IMPORT_EMAIL ?? 'test.admin@example.com';
const PASS = process.env.IMPORT_PASSWORD ?? '123456';

interface Envelope<T> {
  data?: T;
  errors?: unknown;
}

describe('the Import button, against deployed staging', () => {
  it('plans, writes and links as a WeCare Admin', async () => {
    const login = (await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then((r) => r.json())) as Envelope<{ access_token?: string }>;
    expect(login.data?.access_token, 'the WeCare Admin could not sign in').toBeTruthy();
    const H = {
      Authorization: `Bearer ${login.data!.access_token}`,
      'Content-Type': 'application/json',
    };

    const get = async <T>(p: string): Promise<T[]> => {
      const r = (await fetch(`${API}${p}`, { headers: H }).then((x) => x.json())) as Envelope<T[]>;
      if (r.errors) throw new Error(`${p}: ${JSON.stringify(r.errors).slice(0, 200)}`);
      return r.data ?? [];
    };

    // ── the same context the dialog builds ────────────────────────────────
    const storeRows = await get<{
      id: string;
      code: string | null;
      name: string | null;
      city: string | null;
      area_manager: string | null;
      chain_manager: string | null;
      yiji_restaurant_id: string | null;
      brand: { code?: string | null; name?: string | null; yiji_brand_name?: string | null } | null;
    }>(
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

    const tickets = await get<{
      complaint_date: string | null;
      order_id: string | null;
      description: string | null;
    }>('/items/tickets?limit=-1&fields=complaint_date,order_id,description');
    const contacts = await get<{ id: string; phone: string | null }>(
      '/items/contacts?limit=-1&fields=id,phone',
    );
    const users = await get<{ id: string; first_name: string | null }>(
      '/users?limit=-1&fields=id,first_name',
    );
    const vendors = await get<{ id: string }>('/items/vendors?limit=1&fields=id');

    const contactByPhone = new Map<string, string>();
    for (const c of contacts) if (c.phone) contactByPhone.set(String(c.phone), c.id);
    const agentByName = new Map<string, string>();
    for (const u of users) {
      const n = (u.first_name ?? '').trim().toLowerCase();
      if (n && !agentByName.has(n)) agentByName.set(n, u.id);
    }

    const parsed = parseTicketsCsv(readFileSync(CSV, 'utf8'));
    const plan = planImport(parsed.rows, {
      index: buildStoreIndex(stores),
      existing: new Set(
        tickets.map((x) =>
          ticketIdentity(x.complaint_date, String(x.order_id ?? ''), String(x.description ?? '')),
        ),
      ),
      contactByPhone,
      agentByName,
      vendorId: vendors[0]?.id ?? null,
    });

    console.log(
      `plan: ${plan.create.length} new, ${plan.duplicates} dupes, ` +
        `${plan.newContacts} contacts, ${plan.unmatchedStores} unmatched`,
    );
    expect(plan.create.length, 'the probe rows were not planned').toBe(2);
    // The probe names a real branch, so it must resolve rather than fall back.
    expect(plan.unmatchedStores).toBe(0);
    expect(plan.create[0]!.payload.assigned_agent, 'the agent was not resolved').toBeTruthy();

    // ── write, exactly as the dialog does ─────────────────────────────────
    const madeContacts: string[] = [];
    const res = await runImport(
      plan,
      {
        createContacts: async (phones) => {
          const r = await fetch(`${API}/items/contacts`, {
            method: 'POST',
            headers: H,
            body: JSON.stringify(phones.map((phone) => ({ phone }))),
          });
          if (!r.ok)
            throw new Error(`contacts: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
          const made =
            ((await r.json()) as Envelope<Array<{ id: string; phone: string }>>).data ?? [];
          for (const c of made) madeContacts.push(c.id);
          return new Map(made.map((c) => [String(c.phone), c.id]));
        },
        createTickets: async (payloads) => {
          const r = await fetch(`${API}/items/tickets`, {
            method: 'POST',
            headers: H,
            body: JSON.stringify(payloads),
          });
          if (!r.ok) throw new Error(`tickets: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        },
      },
      contactByPhone,
    );

    console.log(
      `wrote: ${res.created} tickets, ${res.contactsCreated} contacts, ${res.failed} failed`,
    );
    expect(res.failed, 'rows were refused by the API').toBe(0);
    expect(res.created).toBe(2);

    // ── what actually landed ──────────────────────────────────────────────
    const landed = await get<{
      id: string;
      subject: string;
      contact: string | null;
      assigned_agent: string | null;
      store: string | null;
      store_snapshot: { brandName?: string; areaManager?: string } | null;
    }>(
      '/items/tickets?limit=-1&fields=id,subject,contact,assigned_agent,store,store_snapshot&filter[order_id][_starts_with]=ZZPROBE',
    );
    expect(landed).toHaveLength(2);
    for (const t of landed) {
      // The whole point of the resolution work: a row must arrive attached to
      // its customer, its agent and its branch, or the report cannot cut by them.
      expect(t.contact, 'imported ticket has no customer').toBeTruthy();
      expect(t.assigned_agent, 'imported ticket has no agent').toBeTruthy();
      expect(t.store, 'imported ticket has no branch').toBeTruthy();
      expect(t.store_snapshot?.brandName, 'branch snapshot has no brand').toBeTruthy();
      expect(t.store_snapshot?.areaManager, 'branch snapshot has no area manager').toBeTruthy();
    }

    // ── re-importing the same file must add NOTHING ───────────────────────
    const after = await get<{
      complaint_date: string | null;
      order_id: string | null;
      description: string | null;
    }>('/items/tickets?limit=-1&fields=complaint_date,order_id,description');
    const second = planImport(parsed.rows, {
      index: buildStoreIndex(stores),
      existing: new Set(
        after.map((x) =>
          ticketIdentity(x.complaint_date, String(x.order_id ?? ''), String(x.description ?? '')),
        ),
      ),
      contactByPhone,
      agentByName,
      vendorId: vendors[0]?.id ?? null,
    });
    expect(second.create, 're-import would duplicate').toHaveLength(0);
    expect(second.duplicates).toBe(2);

    // ── clean up everything this test made ────────────────────────────────
    for (const t of landed) {
      await fetch(`${API}/items/tickets/${t.id}`, { method: 'DELETE', headers: H });
    }
    /*
     * Delete the contacts by their PHONE, not by the ids collected during the
     * run. `runImport` only reports the ones it created in the batch it made,
     * and a partial or retried write can leave a contact this list never saw —
     * which it did: the first run of this test left two behind. The phones are
     * fixed by the probe file, so they are the reliable handle.
     */
    for (const id of madeContacts) {
      await fetch(`${API}/items/contacts/${id}`, { method: 'DELETE', headers: H });
    }
    const strays = await get<{ id: string }>(
      '/items/contacts?limit=-1&fields=id&filter[phone][_starts_with]=05000007',
    );
    for (const c of strays) {
      await fetch(`${API}/items/contacts/${c.id}`, { method: 'DELETE', headers: H });
    }

    const leftovers = await get<{ id: string }>(
      '/items/tickets?limit=-1&fields=id&filter[order_id][_starts_with]=ZZPROBE',
    );
    expect(leftovers, 'probe tickets were left behind').toHaveLength(0);
    const contactsLeft = await get<{ id: string }>(
      '/items/contacts?limit=-1&fields=id&filter[phone][_starts_with]=05000007',
    );
    expect(contactsLeft, 'probe contacts were left behind').toHaveLength(0);
    console.log('cleaned up');
  }, 600_000);
});
