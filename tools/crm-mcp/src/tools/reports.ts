import type { CrmClient } from '../client.js';
import { person, rangeFilter, riyadhDay } from '../format.js';

type Row = Record<string, unknown>;

/** Directus returns aggregate values as `{count: {id: "3"}}` or `{count: "3"}`. */
function aggNumber(row: Row, fn: string, field: string): number {
  const v = row[fn];
  if (v && typeof v === 'object') return Number((v as Row)[field] ?? 0) || 0;
  return Number(v ?? 0) || 0;
}

function groupKey(row: Row, field: string): string | null {
  const v = row[field];
  if (v && typeof v === 'object') return String((v as Row).id ?? '') || null;
  return v === null || v === undefined ? null : String(v);
}

interface AgentCounts {
  chats: number;
  replies: number;
  ticketsCreated: number;
  ticketsSolved: number;
  couponsRequested: number;
}

export async function agentActivity(c: CrmClient, from: string, to: string): Promise<string> {
  const notNote = {
    _or: [{ is_internal_note: { _eq: false } }, { is_internal_note: { _null: true } }],
  };
  const msgRange = rangeFilter('date_created', from, to);
  const created = rangeFilter('date_created', from, to);
  const resolved = rangeFilter('resolved_at', from, to);
  if (!msgRange || !created || !resolved) return 'Give both from and to.';

  const [replies, ticketsCreated, ticketsSolved, coupons] = await Promise.all([
    c.items<Row>('messages', {
      filter: { _and: [{ sender_type: { _eq: 'agent' } }, notNote, msgRange] },
      aggregate: { countDistinct: 'conversation', count: 'id' },
      groupBy: ['sender_user'],
      limit: -1,
    }),
    c.items<Row>('tickets', {
      filter: created,
      aggregate: { count: 'id' },
      groupBy: ['user_created'],
      limit: -1,
    }),
    c.items<Row>('tickets', {
      filter: resolved,
      aggregate: { count: 'id' },
      groupBy: ['assigned_agent'],
      limit: -1,
    }),
    c.items<Row>('coupon_approvals', {
      filter: created,
      aggregate: { count: 'id' },
      groupBy: ['requested_by'],
      limit: -1,
    }),
  ]);

  const by = new Map<string, AgentCounts>();
  const slot = (id: string | null) => {
    const key = id ?? '(none)';
    let s = by.get(key);
    if (!s) {
      s = { chats: 0, replies: 0, ticketsCreated: 0, ticketsSolved: 0, couponsRequested: 0 };
      by.set(key, s);
    }
    return s;
  };
  for (const r of replies) {
    const s = slot(groupKey(r, 'sender_user'));
    s.chats += aggNumber(r, 'countDistinct', 'conversation');
    s.replies += aggNumber(r, 'count', 'id');
  }
  for (const r of ticketsCreated)
    slot(groupKey(r, 'user_created')).ticketsCreated += aggNumber(r, 'count', 'id');
  for (const r of ticketsSolved)
    slot(groupKey(r, 'assigned_agent')).ticketsSolved += aggNumber(r, 'count', 'id');
  for (const r of coupons)
    slot(groupKey(r, 'requested_by')).couponsRequested += aggNumber(r, 'count', 'id');

  const ids = [...by.keys()].filter((k) => k !== '(none)');
  const names = new Map<string, string>();
  if (ids.length) {
    const users = await c.items<Row>('directus_users', {
      fields: ['id', 'first_name', 'last_name', 'email'],
      filter: { id: { _in: ids } },
      limit: -1,
    });
    for (const u of users) names.set(String(u.id), person(u));
  }

  const rows = [...by.entries()]
    .map(([id, s]) => ({
      name: id === '(none)' ? '(no user: automated/system)' : (names.get(id) ?? id),
      ...s,
    }))
    .sort((a, b) => b.chats - a.chats || b.ticketsCreated - a.ticketsCreated);
  const total = rows.reduce(
    (t, r) => ({
      chats: t.chats + r.chats,
      replies: t.replies + r.replies,
      ticketsCreated: t.ticketsCreated + r.ticketsCreated,
      ticketsSolved: t.ticketsSolved + r.ticketsSolved,
      couponsRequested: t.couponsRequested + r.couponsRequested,
    }),
    { chats: 0, replies: 0, ticketsCreated: 0, ticketsSolved: 0, couponsRequested: 0 },
  );

  const out = [
    `Agent activity ${from}..${to} (Riyadh days, inclusive)`,
    'What each number counts:',
    '  chats    = distinct conversations the agent sent at least one non-internal message in, in range',
    '  replies  = agent messages sent in range (internal notes excluded)',
    '  t.created = tickets whose date_created is in range, by the user who created them',
    '  t.solved  = tickets whose resolved_at is in range, by their CURRENT assigned agent',
    '  coupons  = coupon_approvals requested in range, by requested_by (any outcome)',
    '',
    'agent | chats | replies | t.created | t.solved | coupons',
  ];
  for (const r of rows) {
    out.push(
      `${r.name} | ${r.chats} | ${r.replies} | ${r.ticketsCreated} | ${r.ticketsSolved} | ${r.couponsRequested}`,
    );
  }
  if (!rows.length) out.push('(no activity in range)');
  out.push(
    `TOTAL | ${total.chats}* | ${total.replies} | ${total.ticketsCreated} | ${total.ticketsSolved} | ${total.couponsRequested}`,
    '* the chats total double-counts a conversation more than one agent replied in.',
  );
  return out.join('\n');
}

interface Usage {
  calls: number;
  errors: number;
  input: number;
  output: number;
  thinking: number;
  cost: number;
}

const PAGE = 2000;
const MAX_PAGES = 25;

export async function aiUsage(
  c: CrmClient,
  from: string,
  to: string,
  by: 'day' | 'endpoint' | 'model' | 'all' = 'all',
): Promise<string> {
  const range = rangeFilter('date_created', from, to);
  if (!range) return 'Give both from and to.';
  const rows: Row[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await c.items<Row>('ai_calls', {
      fields: [
        'date_created',
        'endpoint',
        'model',
        'status',
        'input_tokens',
        'output_tokens',
        'thinking_tokens',
        'est_cost_usd',
      ],
      filter: range,
      sort: ['date_created'],
      limit: PAGE,
      offset: page * PAGE,
    });
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  const empty = (): Usage => ({ calls: 0, errors: 0, input: 0, output: 0, thinking: 0, cost: 0 });
  const total = empty();
  const dims: Record<'day' | 'endpoint' | 'model', Map<string, Usage>> = {
    day: new Map(),
    endpoint: new Map(),
    model: new Map(),
  };
  const add = (u: Usage, r: Row) => {
    u.calls += 1;
    if (r.status && r.status !== 'ok' && r.status !== 'success') u.errors += 1;
    u.input += Number(r.input_tokens ?? 0) || 0;
    u.output += Number(r.output_tokens ?? 0) || 0;
    u.thinking += Number(r.thinking_tokens ?? 0) || 0;
    u.cost += Number(r.est_cost_usd ?? 0) || 0;
  };
  for (const r of rows) {
    add(total, r);
    const keys = {
      day: riyadhDay(r.date_created),
      endpoint: String(r.endpoint ?? '-'),
      model: String(r.model ?? '-'),
    };
    for (const d of ['day', 'endpoint', 'model'] as const) {
      let u = dims[d].get(keys[d]);
      if (!u) dims[d].set(keys[d], (u = empty()));
      add(u, r);
    }
  }

  const fmt = (k: string, u: Usage) =>
    `${k} | ${u.calls} | ${u.errors} | ${u.input} | ${u.output} | ${u.thinking} | $${u.cost.toFixed(4)}`;
  const statuses = [...new Set(rows.map((r) => String(r.status ?? '-')))].join(', ');
  const out = [
    `AI usage (ai_calls) ${from}..${to} (Riyadh days, inclusive)${truncated ? ` — TRUNCATED at ${PAGE * MAX_PAGES} rows` : ''}`,
    `Statuses seen: ${statuses || '-'} ("errors" = status other than ok/success). Cost is the stored estimate, est_cost_usd.`,
    `columns: key | calls | errors | input tok | output tok | thinking tok | est cost`,
    fmt('TOTAL', total),
  ];
  const which = by === 'all' ? (['day', 'endpoint', 'model'] as const) : ([by] as const);
  for (const d of which) {
    out.push('', `By ${d}:`);
    const entries = [...dims[d].entries()].sort((a, b) =>
      d === 'day' ? a[0].localeCompare(b[0]) : b[1].cost - a[1].cost,
    );
    for (const [k, u] of entries) out.push(fmt(k, u));
    if (!entries.length) out.push('(none)');
  }
  return out.join('\n');
}
