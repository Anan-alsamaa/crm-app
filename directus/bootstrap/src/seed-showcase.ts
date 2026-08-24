/**
 * SHOWCASE seeder — demo data shaped for a live presentation.
 *
 * `seed-demo.ts` proves the portals work: a handful of rows, enough to click
 * through. That is the wrong shape for a demo to a client, where the dashboard
 * is the first thing on screen and a chart drawn from 8 tickets on one day
 * renders as a single flat block that makes the product look empty.
 *
 * This seeds VOLUME SPREAD OVER TIME, which is what makes analytics legible:
 *   - ~90 days of history so trend lines have a curve, not a spike
 *   - a weekday/weekend rhythm, so "conversation volume" looks like a real week
 *   - a realistic status mix (most resolved, some open, a few overdue)
 *   - CSAT skewed positive but NOT perfect — an all-5s chart reads as fake
 *   - several vendors and agents, so "by agent" and "by vendor" have bars
 *
 * Every row it creates is tagged `showcase` in a way it can find again, so
 * re-running replaces rather than duplicates.
 *
 * LOCAL DEMO ONLY. Never point this at production.
 *
 *   pnpm --filter @yiji/directus-bootstrap seed:showcase
 */
const DIRECTUS = process.env.DIRECTUS_INTERNAL_URL ?? 'http://localhost:8055';
const ADMIN_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const ADMIN_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

/** Refuse to run against anything that is not obviously local. */
if (!/localhost|127\.0\.0\.1/.test(DIRECTUS)) {
  console.error(`REFUSING: ${DIRECTUS} is not local. This seeder is for demos only.`);
  process.exit(1);
}

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
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/* Deterministic PRNG — a demo that reshuffles every run is impossible to
 * rehearse against, and screenshots stop matching what is on screen. */
let seed = 20260810;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T;
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

const DAY = 86_400_000;
const now = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

const VENDORS = [
  'Wecare Pharmacy',
  'Nahdi Express',
  'Al Dawaa Retail',
  'Whites Pharmacy',
  'Care Plus Clinics',
];
const FIRST = [
  'Sara',
  'Omar',
  'Layla',
  'Yousef',
  'Huda',
  'Khalid',
  'Noura',
  'Faisal',
  'Reem',
  'Tariq',
];
const LAST = ['Al-Qahtani', 'Al-Harbi', 'Al-Otaibi', 'Al-Ghamdi', 'Al-Shehri', 'Al-Dosari'];

const SUBJECTS = [
  'Order arrived with an item missing',
  'Refund not received after cancellation',
  'Wrong dosage delivered',
  'Delivery delayed past the promised slot',
  'Damaged packaging on arrival',
  'Prescription upload keeps failing',
  'Charged twice for the same order',
  'Need to change the delivery address',
  'Item out of stock after payment',
  'Courier could not find the address',
  'Requesting an invoice for insurance',
  'Product expired on arrival',
];

const OPENERS = [
  'Hello, I placed an order this morning and one item is missing.',
  'Hi — I cancelled yesterday but I still have not seen the refund.',
  'The delivery was supposed to arrive before 6pm and it has not.',
  'I received the wrong strength for my prescription.',
  'The box arrived crushed and one bottle had leaked.',
  'Every time I upload my prescription the app throws an error.',
];
const AGENT_REPLIES = [
  'Thank you for reaching out — I am checking your order now.',
  'I am sorry about that. I can see the order and I am raising it with the pharmacy.',
  'I have escalated this to the delivery partner and asked for a same-day resolution.',
  'A refund has been issued; it should appear within 3 working days.',
  'I have arranged a replacement at no charge — it will arrive tomorrow.',
];
const CLOSERS = [
  'Thank you, that resolves it.',
  'Perfect, appreciate the quick help.',
  'Received the replacement, all good now.',
];

interface Row {
  id: string;
}

async function main(): Promise<void> {
  const auth = await api<{ data: { access_token: string } }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  TOKEN = auth.data.access_token;
  console.log(`Authenticated against ${DIRECTUS}`);

  // --- vendors -------------------------------------------------------------
  const existingVendors = (
    await api<{ data: Array<Row & { name: string }> }>('/items/vendors?limit=-1&fields=id,name')
  ).data;
  const vendorIds: string[] = [];
  for (const name of VENDORS) {
    const found = existingVendors.find((v) => v.name === name);
    if (found) {
      vendorIds.push(found.id);
      continue;
    }
    const created = await api<{ data: Row }>('/items/vendors', {
      method: 'POST',
      // yiji_vendor_id is REQUIRED by the schema — it is the join key back to the
      // Yiji platform. Demo vendors get a clearly-fake id so they can never be
      // mistaken for a real vendor mapping.
      body: JSON.stringify({
        name,
        status: 'active',
        yiji_vendor_id: `demo-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      }),
    });
    vendorIds.push(created.data.id);
  }
  console.log(`Vendors: ${vendorIds.length}`);

  // --- agents (real Directus users so "by agent" charts have bars) ----------
  const roles = (
    await api<{ data: Array<Row & { name: string }> }>('/roles?limit=-1&fields=id,name')
  ).data;
  const agentRole = roles.find((r) => r.name === 'Agent');
  const users = (
    await api<{ data: Array<Row & { email: string }> }>('/users?limit=-1&fields=id,email')
  ).data;
  const agentIds: string[] = [];
  const AGENTS = [
    ['Mona', 'Al-Fahad', 'mona.demo@example.com'],
    ['Ziad', 'Al-Rashed', 'ziad.demo@example.com'],
    ['Dina', 'Al-Sayed', 'dina.demo@example.com'],
  ] as const;
  for (const [first, last, email] of AGENTS) {
    const found = users.find((u) => u.email === email);
    if (found) {
      agentIds.push(found.id);
      continue;
    }
    const created = await api<{ data: Row }>('/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'DemoAgentPass1!',
        first_name: first,
        last_name: last,
        status: 'active',
        ...(agentRole ? { role: agentRole.id } : {}),
      }),
    });
    agentIds.push(created.data.id);
  }
  // Include any pre-existing agents so the workload chart is not artificially narrow.
  const allAgents = agentIds.length ? agentIds : users.slice(0, 3).map((u) => u.id);
  console.log(`Agents: ${allAgents.length}`);

  // --- contacts ------------------------------------------------------------
  const existingContacts = (
    await api<{ data: Array<Row & { email: string | null }> }>(
      '/items/contacts?limit=-1&fields=id,email',
    )
  ).data;
  const contactIds: string[] = [];
  for (let i = 0; i < 40; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const email = `showcase.${i}@example.com`;
    const found = existingContacts.find((c) => c.email === email);
    if (found) {
      contactIds.push(found.id);
      continue;
    }
    const created = await api<{ data: Row }>('/items/contacts', {
      method: 'POST',
      body: JSON.stringify({
        name: `${first} ${last}`,
        email,
        phone: `05${int(10_000_000, 99_999_999)}`,
        vendor: pick(vendorIds),
      }),
    });
    contactIds.push(created.data.id);
  }
  console.log(`Contacts: ${contactIds.length}`);

  // --- conversations + messages + tickets, spread across 90 days -----------
  // Weekday rhythm: Sat/Sun in KSA are the weekend, so volume dips there. A flat
  // distribution is the tell that data was generated rather than observed.
  // `conversations` has NO subject field, so showcase rows are detected by their
  // linked contact instead — every generated contact uses a showcase.* email.
  const existingConvos = (
    await api<{ data: Array<Row & { contact: string | null }> }>(
      '/items/conversations?limit=-1&fields=id,contact',
    )
  ).data;
  const showcaseContacts = new Set(contactIds);
  if (existingConvos.filter((c) => c.contact && showcaseContacts.has(c.contact)).length > 50) {
    console.log('Showcase conversations already present — skipping generation.');
  } else {
    let convos = 0;
    let msgs = 0;
    let tickets = 0;
    let csats = 0;

    for (let d = 89; d >= 0; d--) {
      const dayStart = now - d * DAY;
      const dow = new Date(dayStart).getUTCDay(); // 0 Sun .. 6 Sat
      const weekend = dow === 5 || dow === 6; // Fri/Sat weekend in KSA
      // Gentle upward trend over the window so the line rises left-to-right.
      const trend = 1 + (89 - d) / 120;
      const count = Math.max(1, Math.round((weekend ? int(1, 3) : int(3, 7)) * trend));

      for (let k = 0; k < count; k++) {
        const openedAt = dayStart + int(7, 20) * 3_600_000 + int(0, 59) * 60_000;
        const contact = pick(contactIds);
        const vendor = pick(vendorIds);
        const agent = pick(allAgents);
        const subject = pick(SUBJECTS);

        const convo = await api<{ data: Row }>('/items/conversations', {
          method: 'POST',
          body: JSON.stringify({
            // No `subject` on conversations — the ticket carries it.
            status: pick(['open', 'open', 'solved'] as const),
            priority: pick(['low', 'medium', 'medium', 'high', 'urgent'] as const),
            contact,
            vendor,
            assigned_agent: agent,
            // Settable, unlike date_created — this is what the volume chart plots.
            last_message_at: iso(openedAt),
          }),
        });
        convos++;

        // 2–5 messages, alternating customer/agent. No timestamp is sent: Directus
        // owns date_created, so message times are corrected afterwards by
        // sql/backdate-showcase.sql, which spreads them across the conversation.
        const turns = int(2, 5);
        for (let m = 0; m < turns; m++) {
          const inbound = m % 2 === 0;
          await api('/items/messages', {
            method: 'POST',
            body: JSON.stringify({
              conversation: convo.data.id,
              // Schema uses sender_type/content (not direction/body), and has no
              // settable timestamp — date_created is system-managed, so message
              // times are "now". Charts read conversations.last_message_at and the
              // ticket date fields, which ARE backdated, so this does not matter.
              sender_type: inbound ? 'customer' : 'agent',
              content: inbound ? (m === 0 ? pick(OPENERS) : pick(CLOSERS)) : pick(AGENT_REPLIES),
              is_internal_note: false,
            }),
          });
          msgs++;
        }

        // ~55% of conversations raise a ticket.
        if (rnd() < 0.55) {
          const firstResponseMin = int(2, 45);
          const resolutionMin = firstResponseMin + int(30, 900);
          // Status mix: mostly resolved/closed, a live tail of open work.
          const roll = rnd();
          const status =
            d < 7 && roll < 0.25
              ? 'new'
              : d < 7 && roll < 0.5
                ? 'open'
                : roll < 0.12
                  ? 'pending'
                  : roll < 0.62
                    ? 'resolved'
                    : 'closed';
          const respondedAt = openedAt + firstResponseMin * 60_000;
          const resolvedAt = openedAt + resolutionMin * 60_000;
          // TICKET status, which still has five values — not the chat's two.
          const done = status === 'resolved' || status === 'closed';

          await api('/items/tickets', {
            method: 'POST',
            body: JSON.stringify({
              subject,
              description: `Raised from a customer conversation about: ${subject.toLowerCase()}.`,
              status,
              priority: pick(['low', 'medium', 'medium', 'high', 'urgent'] as const),
              conversation: convo.data.id,
              contact,
              vendor,
              assigned_agent: agent,
              // A due time in the past on an unresolved ticket is what makes the
              // "overdue" tile non-zero — without it the SLA panel looks inert.
              first_response_due_at: iso(openedAt + 30 * 60_000),
              resolution_due_at: iso(openedAt + 8 * 3_600_000),
              first_responded_at: iso(respondedAt),
              ...(done ? { resolved_at: iso(resolvedAt) } : {}),
              ...(status === 'closed' ? { closed_at: iso(resolvedAt + 3_600_000) } : {}),
            }),
          });
          tickets++;

          // CSAT on ~40% of finished tickets, skewed positive but not perfect.
          if (done && rnd() < 0.4) {
            const score = rnd() < 0.72 ? 5 : rnd() < 0.85 ? 4 : rnd() < 0.94 ? 3 : int(1, 2);
            await api('/items/csat_responses', {
              method: 'POST',
              body: JSON.stringify({
                conversation: convo.data.id,
                contact,
                score,
                submitted_at: iso(resolvedAt + 7_200_000),
              }),
            });
            csats++;
          }
        }
      }
    }
    console.log(
      `Generated: ${convos} conversations, ${msgs} messages, ${tickets} tickets, ${csats} CSAT responses`,
    );
  }

  console.log('\nShowcase data ready.');
}

main().catch((err: unknown) => {
  console.error('Seeding failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

// Marks this file as a MODULE. Without it TypeScript treats both seeders as
// global scripts and their top-level consts collide (seed-demo declares the
// same DIRECTUS / TOKEN names).
export {};

// Marks this file as a MODULE. Without it TypeScript treats both seeders as
// global scripts and their top-level consts collide with seed-demo's.
export {};
