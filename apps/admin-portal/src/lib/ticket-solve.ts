import { readItems, readRevisions } from '@directus/sdk';
import { normaliseTicketStatus } from '@yiji/shared-types';
import { readChunked, ticketChatSession, type TimingMessage } from '@yiji/reports';
import { directus } from './directus.js';

/**
 * THE FACTS A TICKET'S SOLVE TIME AND 1st REPLY NEED, read once for a set of
 * tickets — shared by the Agent summary and Ticket deadlines so the two
 * reports feed the SAME inputs to the same rule (`ticketSolveSec` in
 * @yiji/reports). See packages/reports/src/ticket-solve.ts for the why.
 *
 *  - `session`: per ticket, the chat session it was raised from (first
 *    customer message + first human reply), from the messages of its linked
 *    conversation;
 *  - `solvedServerAt`: per ticket, when the SERVER recorded it becoming
 *    solved (the last revision that set a solved status, or the creation if it
 *    was filed solved). Read only for tickets whose browser `resolved_at` is
 *    missing or before their creation — a handful.
 *
 * Best-effort, both halves: a failed read costs that fallback, never the
 * report (it warns, it does not swallow silently).
 */
export interface TicketSolveRow {
  id: string;
  status?: string | null;
  date_created: string | null;
  resolved_at: string | null;
  conversation?: string | null;
}

export interface TicketSolveContext {
  session: Map<string, { customerAt: string; agentAt: string | null }>;
  solvedServerAt: Map<string, string>;
}

const MESSAGE_FIELDS = ['conversation', 'sender_type', 'date_created', 'sender_user'];

export async function loadTicketSolveContext(
  tickets: readonly TicketSolveRow[],
  /** Messages the caller already holds, by conversation id (saves a re-read). */
  known?: ReadonlyMap<string, readonly TimingMessage[]>,
): Promise<TicketSolveContext> {
  const session: TicketSolveContext['session'] = new Map();
  const solvedServerAt: TicketSolveContext['solvedServerAt'] = new Map();

  const convIds = [
    ...new Set(
      tickets.map((t) => t.conversation).filter((c): c is string => !!c && !known?.has(c)),
    ),
  ];
  const needServer = tickets.filter(
    (t) =>
      normaliseTicketStatus(t.status ?? '') === 'solved' &&
      (!t.resolved_at || (!!t.date_created && t.resolved_at < t.date_created)),
  );

  const [messages, revisions] = await Promise.all([
    convIds.length === 0
      ? Promise.resolve([] as TimingMessage[])
      : readChunked(
          convIds,
          (ids) =>
            directus.request(
              readItems('messages', {
                filter: { conversation: { _in: ids }, is_internal_note: { _eq: false } } as never,
                fields: MESSAGE_FIELDS as never,
                limit: -1,
              }),
            ) as Promise<TimingMessage[]>,
          undefined,
          4,
        ).catch((err: unknown) => {
          console.warn('[ticket-solve] could not read chat messages:', err);
          return [] as TimingMessage[];
        }),
    needServer.length === 0
      ? Promise.resolve([] as RevisionRow[])
      : readChunked(
          needServer.map((t) => t.id),
          (ids) =>
            directus.request(
              /* `readRevisions`, never readItems('directus_revisions') — a
                 system collection 403s on /items. */
              readRevisions({
                filter: { collection: { _eq: 'tickets' }, item: { _in: ids } } as never,
                fields: ['item', 'delta', 'activity.timestamp'] as never,
                limit: -1,
              }),
            ) as unknown as Promise<RevisionRow[]>,
          undefined,
          4,
        ).catch((err: unknown) => {
          console.warn('[ticket-solve] could not read ticket revisions:', err);
          return [] as RevisionRow[];
        }),
  ]);

  const byConv = new Map<string, TimingMessage[]>();
  for (const [id, list] of known ?? []) byConv.set(id, [...list]);
  for (const m of messages) {
    const list = byConv.get(m.conversation);
    if (list) list.push(m);
    else byConv.set(m.conversation, [m]);
  }
  for (const t of tickets) {
    const msgs = t.conversation ? byConv.get(t.conversation) : undefined;
    if (!msgs) continue;
    const s = ticketChatSession(msgs, t.date_created);
    if (s) session.set(t.id, s);
  }

  for (const r of revisions) {
    const status = r.delta && typeof r.delta === 'object' ? r.delta.status : undefined;
    const at = r.activity?.timestamp;
    if (typeof status !== 'string' || !at || normaliseTicketStatus(status) !== 'solved') continue;
    const id = String(r.item);
    const prev = solvedServerAt.get(id);
    // The LAST solve wins: a reopened ticket was solved when it was last closed.
    if (!prev || at > prev) solvedServerAt.set(id, at);
  }
  return { session, solvedServerAt };
}

interface RevisionRow {
  item: string | number;
  delta: { status?: unknown } | null;
  activity: { timestamp?: string | null } | null;
}
