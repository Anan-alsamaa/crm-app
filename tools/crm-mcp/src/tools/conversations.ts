import type { CrmClient } from '../client.js';
import { clip, person, phoneNeedle, rangeFilter, rel, when } from '../format.js';

type Row = Record<string, unknown>;

const USER = (p: string) => [`${p}.first_name`, `${p}.last_name`];

export interface ConversationSearch {
  phone?: string;
  name?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function searchConversations(c: CrmClient, a: ConversationSearch): Promise<string> {
  const and: object[] = [];
  if (a.phone) and.push({ contact: { phone: { _contains: phoneNeedle(a.phone) } } });
  if (a.name) and.push({ contact: { name: { _icontains: a.name } } });
  if (a.status) and.push({ status: { _eq: a.status } });
  const range = rangeFilter('last_message_at', a.from, a.to);
  if (range) and.push(range);
  const limit = Math.min(a.limit ?? 20, 100);

  const rows = await c.items<Row>('conversations', {
    fields: [
      'id',
      'status',
      'date_created',
      'last_message_at',
      'solved_at',
      'contact.name',
      'contact.phone',
      ...USER('assigned_agent'),
      'vendor.name',
    ],
    filter: and.length ? { _and: and } : undefined,
    sort: ['-last_message_at'],
    limit,
  });

  const lines = [
    `Conversations: ${rows.length}${rows.length === limit ? ` (limit ${limit} reached — narrow the search)` : ''}`,
    `Sorted by last message, newest first. Date range applies to last_message_at (Riyadh days).`,
    '',
  ];
  for (const r of rows) {
    lines.push(
      `${r.id}  [${r.status}]  ${rel(r.contact, 'name')} ${rel(r.contact, 'phone')}`,
      `   agent: ${person(r.assigned_agent)} · vendor: ${rel(r.vendor, 'name')} · started ${when(r.date_created)} · last msg ${when(r.last_message_at)}${r.solved_at ? ` · solved ${when(r.solved_at)}` : ''}`,
    );
  }
  if (!rows.length) lines.push('(no matching conversations)');
  return lines.join('\n');
}

export async function getConversation(
  c: CrmClient,
  id: string,
  messageLimit = 200,
): Promise<string> {
  const conv = await c.item<Row>('conversations', id, [
    'id',
    'status',
    'priority',
    'date_created',
    'last_message_at',
    'solved_at',
    'archived_at',
    'session_started_at',
    'initiated_by',
    'first_response_due_at',
    'first_responded_at',
    'first_response_breached_at',
    'last_order_id',
    'entry_order_id',
    'push_unreachable_at',
    'push_unreachable_reason',
    'contact.id',
    'contact.name',
    'contact.phone',
    'contact.external_customer_id',
    ...USER('assigned_agent'),
    'assigned_team.name',
    'vendor.name',
  ]);
  if (!conv) return `Conversation ${id} not found.`;

  const limit = Math.min(Math.max(messageLimit, 1), 500);
  const [msgsDesc, tickets] = await Promise.all([
    c.items<Row>('messages', {
      fields: [
        'id',
        'date_created',
        'sender_type',
        'source',
        'content',
        'is_internal_note',
        'edited_at',
        'deleted_at',
        'original_content',
        ...USER('sender_user'),
        'sender_contact.name',
      ],
      filter: { conversation: { _eq: id } },
      sort: ['-date_created'],
      limit,
    }),
    c.items<Row>('tickets', {
      fields: ['id', 'subject', 'status', 'order_id', 'date_created', ...USER('assigned_agent')],
      filter: { conversation: { _eq: id } },
      sort: ['date_created'],
      limit: 50,
    }),
  ]);
  const msgs = [...msgsDesc].reverse();

  const breached = conv.first_response_breached_at
    ? `BREACHED ${when(conv.first_response_breached_at)}`
    : 'not breached';
  const out = [
    `Conversation ${conv.id}  [${conv.status}]  priority ${conv.priority ?? '-'}`,
    `Customer: ${rel(conv.contact, 'name')} · ${rel(conv.contact, 'phone')} · yiji id ${rel(conv.contact, 'external_customer_id')}`,
    `Agent: ${person(conv.assigned_agent)} · team ${rel(conv.assigned_team, 'name')} · vendor ${rel(conv.vendor, 'name')} · initiated by ${conv.initiated_by ?? '-'}`,
    `Created ${when(conv.date_created)} · session started ${when(conv.session_started_at)} · last msg ${when(conv.last_message_at)} · solved ${when(conv.solved_at)}`,
    `SLA first response: due ${when(conv.first_response_due_at)} · responded ${when(conv.first_responded_at)} · ${breached}`,
    `Orders: last ${conv.last_order_id ?? '-'} · entry ${conv.entry_order_id ?? '-'}${conv.push_unreachable_at ? ` · PUSH UNREACHABLE ${when(conv.push_unreachable_at)} (${conv.push_unreachable_reason ?? '?'})` : ''}`,
    '',
    `Tickets (${tickets.length}):`,
    ...(tickets.length
      ? tickets.map(
          (t) =>
            `  ${t.id} [${t.status}] ${clip(t.subject, 120)} · order ${t.order_id ?? '-'} · ${person(t.assigned_agent)} · ${when(t.date_created)}`,
        )
      : ['  (none)']),
    '',
    `Messages (${msgs.length}${msgs.length === limit ? `, the latest ${limit} only` : ''}, oldest first):`,
  ];
  for (const m of msgs) {
    const who =
      m.sender_type === 'agent'
        ? `agent ${m.sender_user ? person(m.sender_user) : '(automated)'}`
        : m.sender_type === 'customer'
          ? `customer ${rel(m.sender_contact, 'name')}`
          : String(m.sender_type ?? '?');
    const flags = [
      m.is_internal_note ? 'INTERNAL NOTE' : '',
      m.deleted_at ? `DELETED ${when(m.deleted_at)}` : '',
      m.edited_at ? `EDITED ${when(m.edited_at)}` : '',
      m.source ? `src:${m.source}` : '',
    ].filter(Boolean);
    out.push(
      `- ${when(m.date_created)} ${who}${flags.length ? ` [${flags.join(' · ')}]` : ''}: ${clip(m.content, 600)}`,
    );
    if ((m.edited_at || m.deleted_at) && m.original_content && m.original_content !== m.content) {
      out.push(`    original: ${clip(m.original_content, 400)}`);
    }
  }
  if (!msgs.length) out.push('  (no messages)');
  return out.join('\n');
}
