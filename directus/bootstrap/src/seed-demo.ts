/**
 * Demo data seeder for a LOCAL Directus instance (idempotent).
 *
 * Populates a freshly-bootstrapped instance so the portals are usable out of the
 * box: vendor, teams, tags, an SLA policy, a demo agent, contacts, conversations
 * with messages, and a couple of tickets. Safe to re-run — it detects its own
 * `seed-*` contacts and skips.
 *
 * Run after `apply`:  pnpm --filter @yiji/directus-bootstrap seed:demo
 * Reads DIRECTUS_INTERNAL_URL (default http://localhost:8055) +
 * DIRECTUS_ADMIN_EMAIL / DIRECTUS_ADMIN_PASSWORD (the project owner).
 *
 * NOT for production — this is demo content for local dev only.
 */
const DIRECTUS = process.env.DIRECTUS_INTERNAL_URL ?? 'http://localhost:8055';
const ADMIN_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const ADMIN_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';
const AGENT_EMAIL = process.env.SEED_AGENT_EMAIL ?? 'e2e.agent@example.com';
const AGENT_PASSWORD = process.env.SEED_AGENT_PASSWORD ?? 'E2eAgentPass1!';

let TOKEN = '';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${DIRECTUS}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const post = <T>(coll: string, body: unknown): Promise<{ data: T }> =>
  api<{ data: T }>(`/items/${coll}`, { method: 'POST', body: JSON.stringify(body) });

/** Find one item by an encoded filter, or create it; returns its id. */
async function getOrCreate(
  coll: string,
  filter: string,
  create: Record<string, unknown>,
): Promise<string> {
  const found = (
    await api<{ data: Array<{ id: string }> }>(`/items/${coll}?${filter}&fields=id&limit=1`)
  ).data;
  if (found[0]) return found[0].id;
  return (await post<{ id: string }>(coll, create)).data.id;
}

/** ISO timestamp `mins` minutes ago. */
const ago = (mins: number): string => new Date(Date.now() - mins * 60_000).toISOString();

async function main(): Promise<void> {
  // Owner login.
  TOKEN = (
    await api<{ data: { access_token: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    })
  ).data.access_token;

  // Idempotence guard: bail if the demo contacts already exist.
  const existing = (
    await api<{ data: Array<{ id: string }> }>(
      `/items/contacts?filter[external_customer_id][_starts_with]=seed-&fields=id&limit=5`,
    )
  ).data;
  if (existing.length >= 5) {
    console.log(`Demo data already present (${existing.length} seed contacts) — nothing to do.`);
    return;
  }

  // Vendor (also seeded by CI / the brief; ensure it exists here too).
  const vendor = await getOrCreate('vendors', 'filter[yiji_vendor_id][_eq]=demo-vendor', {
    yiji_vendor_id: 'demo-vendor',
    name: 'Demo Vendor',
    status: 'active',
  });

  // Teams.
  const teamSupport = await getOrCreate('teams', 'filter[name][_eq]=Support', {
    name: 'Support',
    description: 'Front-line customer support',
  });
  await getOrCreate('teams', 'filter[name][_eq]=Sales', {
    name: 'Sales',
    description: 'Pre-sales & account questions',
  });

  // Demo agent (Agent role) on the Support team.
  const agentRole = (
    await api<{ data: Array<{ id: string }> }>('/roles?filter[name][_eq]=Agent&fields=id&limit=1')
  ).data[0]?.id;
  if (!agentRole) throw new Error('Agent role not found — run `apply` first.');
  const foundAgent = (
    await api<{ data: Array<{ id: string }> }>(
      `/users?filter[email][_eq]=${encodeURIComponent(AGENT_EMAIL)}&fields=id&limit=1`,
    )
  ).data;
  const agentId = foundAgent[0]
    ? foundAgent[0].id
    : (
        await post<{ id: string }>('users', {
          email: AGENT_EMAIL,
          password: AGENT_PASSWORD,
          role: agentRole,
          status: 'active',
        })
      ).data.id;
  await api(`/users/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ team: teamSupport, first_name: 'Yara', last_name: 'Agent' }),
  });

  // Tags.
  const tag: Record<string, string> = {};
  for (const t of [
    { name: 'billing', color: '#ef4444' },
    { name: 'bug', color: '#f59e0b' },
    { name: 'vip', color: '#8b5cf6' },
    { name: 'refund', color: '#10b981' },
  ]) {
    tag[t.name] = await getOrCreate('tags', `filter[name][_eq]=${t.name}`, t);
  }

  // SLA policy.
  const sla = await getOrCreate('sla_policies', 'filter[name][_eq]=Standard', {
    name: 'Standard',
    description: 'Default SLA',
    applies_to_priority: ['low', 'medium', 'high', 'urgent'],
    first_response_minutes: 30,
    resolution_minutes: 480,
    warning_threshold_percent: 80,
    active: true,
  });

  // Contacts + conversations + messages + tag links.
  type Msg = [sender: 'customer' | 'agent', content: string, minsAgo: number];
  interface Person {
    ext: string;
    name: string;
    email: string;
    phone: string;
    status: string;
    priority: string;
    assigned: boolean;
    unread: number;
    minsAgo: number;
    tags: string[];
    msgs: Msg[];
  }
  const people: Person[] = [
    {
      ext: 'seed-1',
      name: 'Sarah Khan',
      email: 'sarah@acme.com',
      phone: '+966500000001',
      status: 'open',
      priority: 'high',
      assigned: true,
      unread: 2,
      minsAgo: 4,
      tags: ['billing', 'vip'],
      msgs: [
        ['customer', 'Hi, I was double-charged this month.', 9],
        ['agent', 'Hi Sarah — checking your invoices now.', 6],
        ['customer', 'Thank you!', 4],
      ],
    },
    {
      ext: 'seed-2',
      name: 'Ahmed Ali',
      email: 'ahmed@shop.sa',
      phone: '+966500000002',
      status: 'open',
      priority: 'medium',
      assigned: false,
      unread: 1,
      minsAgo: 12,
      tags: ['bug'],
      msgs: [
        ['customer', 'The app crashes when I tap checkout.', 13],
        ['customer', 'Still happening on iPhone.', 12],
      ],
    },
    {
      ext: 'seed-3',
      name: 'Maria Lopez',
      email: 'maria@mail.com',
      phone: '+966500000003',
      status: 'pending',
      priority: 'low',
      assigned: true,
      unread: 0,
      minsAgo: 70,
      tags: ['refund'],
      msgs: [
        ['customer', 'When will my refund arrive?', 80],
        ['agent', 'Refunds take 3-5 business days.', 70],
      ],
    },
    {
      ext: 'seed-4',
      name: 'John Park',
      email: 'john@biz.io',
      phone: '+966500000004',
      status: 'resolved',
      priority: 'medium',
      assigned: true,
      unread: 0,
      minsAgo: 240,
      tags: [],
      msgs: [
        ['customer', 'How do I change my address?', 250],
        ['agent', 'Settings > Profile > Address. Done!', 240],
      ],
    },
    {
      ext: 'seed-5',
      name: 'Layla Hassan',
      email: 'layla@vip.com',
      phone: '+966500000005',
      status: 'open',
      priority: 'urgent',
      assigned: false,
      unread: 3,
      minsAgo: 2,
      tags: ['vip', 'refund'],
      msgs: [
        ['customer', 'My order never arrived and no refund!', 6],
        ['customer', 'This is urgent please.', 3],
        ['customer', 'Hello?', 2],
      ],
    },
  ];

  const byName: Record<string, { contact: string; conv: string }> = {};
  for (const p of people) {
    const contact = (
      await post<{ id: string }>('contacts', {
        vendor,
        external_customer_id: p.ext,
        name: p.name,
        email: p.email,
        phone: p.phone,
      })
    ).data.id;
    const conv = (
      await post<{ id: string }>('conversations', {
        vendor,
        contact,
        status: p.status,
        priority: p.priority,
        unread_count_agent: p.unread,
        last_message_at: ago(p.minsAgo),
        assigned_agent: p.assigned ? agentId : null,
      })
    ).data.id;
    for (const [sender, content, m] of p.msgs) {
      await post('messages', {
        conversation: conv,
        sender_type: sender,
        content,
        date_created: ago(m),
        ...(sender === 'customer' ? { sender_contact: contact } : { sender_user: agentId }),
      });
    }
    for (const tn of p.tags) {
      await post('conversations_tags', { conversations_id: conv, tags_id: tag[tn] });
    }
    byName[p.name] = { contact, conv };
    console.log(`  conversation: ${p.name} [${p.status}/${p.priority}] (${p.msgs.length} msgs)`);
  }

  // Tickets from two of the conversations (+ append-only `created` events).
  const ahmed = byName['Ahmed Ali']!;
  const layla = byName['Layla Hassan']!;
  const t1 = (
    await post<{ id: string }>('tickets', {
      subject: 'App crashes on checkout',
      description: 'Customer reports a crash when tapping checkout on iPhone.',
      status: 'open',
      priority: 'high',
      vendor,
      contact: ahmed.contact,
      conversation: ahmed.conv,
      assigned_agent: agentId,
      sla_policy: sla,
      first_response_due_at: ago(-30),
      resolution_due_at: ago(-480),
    })
  ).data.id;
  await post('ticket_events', {
    ticket: t1,
    event_type: 'created',
    actor: agentId,
    payload: { by: 'seed' },
  });
  const t2 = (
    await post<{ id: string }>('tickets', {
      subject: 'Order never arrived + refund missing',
      description: 'Urgent: undelivered order, refund not received.',
      status: 'new',
      priority: 'urgent',
      vendor,
      contact: layla.contact,
      conversation: layla.conv,
      sla_policy: sla,
      first_response_due_at: ago(-30),
      resolution_due_at: ago(-480),
    })
  ).data.id;
  await post('ticket_events', { ticket: t2, event_type: 'created', payload: { by: 'seed' } });

  console.log('  tickets: 2 created');
  console.log('Demo seed complete.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Demo seed failed:', err);
    process.exit(1);
  });
