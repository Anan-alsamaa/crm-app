/**
 * A CHAT THREAD SPLIT INTO ITS SESSIONS (owner, 2026-11-05).
 *
 * One conversation per contact means a returning customer writes into the SAME
 * thread again and again. The first-response PROMISE is per session - the SLA
 * engine restarts it on every reopen (`session_started_at`) - but the reports
 * measured the whole thread: the customer's first-EVER message to the first
 * reply after it. Production, conversation b08c00f5 on 2026-11-05: Mohamed
 * answered the 00:53 session in 34 min; the customer came back at 07:00 and
 * Shatha answered at 08:20 (0 working minutes - before the 09:00 shift). The
 * report showed "first response 34 min" for the thread and never measured
 * Shatha's reply at all.
 *
 * WHERE A SESSION STARTS - the customer message that opened it:
 *  1. `starts_session === true`, stamped by the chat gateway on the message
 *     that creates a chat or reopens a solved one (from 2026-11-05); or
 *  2. for older messages, the customer message the AUTOMATIC WELCOME answers:
 *     the gateway sends the welcome exactly once per session, right after the
 *     message that opened it (owner, 2026-10-06). A welcome that was not sent
 *     (no template, a failed send) leaves two sessions joined - the old
 *     behaviour for that pair, never a wrong split.
 * Time gaps are deliberately NOT a boundary: a customer who waits five hours
 * overnight is one session, and splitting there would lose exactly the slow
 * replies the report exists to show.
 */
import { conversationTimestamps, type TimingMessage } from './chat-timings.js';

export interface SessionMessage extends TimingMessage {
  /** Where the words came from; `auto_welcome` marks the automatic greeting. */
  source?: string | null;
  /** Stamped by the gateway on the message that opened a session. */
  starts_session?: boolean | null;
}

export interface ChatSession {
  conversation: string;
  /** 0 for the thread's first session, then 1, 2, ... */
  index: number;
  /** Unique across the report: `<conversation>#<index>`. */
  key: string;
  /** The session's first message. */
  startAt: string;
  /** The session's last message. */
  endAt: string;
  /** True for the thread's newest session - the one the chat row describes now. */
  isLatest: boolean;
  firstCustomerAt: string | null;
  firstAgentAt: string | null;
  firstAgentBy: string | null;
  /** The earliest human agent message in the session, customer or not. */
  firstAgentAnyAt: string | null;
  /** Maha resolved it on her own - no person wrote (2026-11-09). */
  handledByMaha: boolean;
  /** When Maha handed it to people, if she did. */
  mahaHandoverAt: string | null;
  /** Maha took part in this session. */
  hadMaha: boolean;
}

/** How soon after the opening message the automatic welcome lands. */
const WELCOME_WINDOW_MS = 120_000;

function opensSession(msgs: readonly SessionMessage[], i: number): boolean {
  const m = msgs[i]!;
  if (m.sender_type !== 'customer') return false;
  if (m.starts_session === true) return true;
  const next = msgs[i + 1];
  /* Maha's introduction replaces the welcome when she has the chat. */
  const greeted = next?.source === 'auto_welcome' || next?.source === 'maha_intro';
  if (!next || !greeted || !m.date_created || !next.date_created) {
    return false;
  }
  const gap = Date.parse(next.date_created) - Date.parse(m.date_created);
  return gap >= 0 && gap <= WELCOME_WINDOW_MS;
}

/**
 * Every conversation's sessions, oldest first. `messages` must exclude internal
 * notes (as for `conversationTimestamps`); order is not assumed.
 */
export function chatSessions(messages: readonly SessionMessage[]): Map<string, ChatSession[]> {
  const byConv = new Map<string, SessionMessage[]>();
  for (const m of messages) {
    if (!m.date_created) continue;
    const list = byConv.get(m.conversation);
    if (list) list.push(m);
    else byConv.set(m.conversation, [m]);
  }
  const out = new Map<string, ChatSession[]>();
  for (const [conversation, raw] of byConv) {
    // Stable: equal timestamps keep their read order (the welcome is written
    // after the message it answers).
    const msgs = raw
      .map((m, i) => ({ m, i }))
      .sort((a, b) =>
        a.m.date_created! < b.m.date_created!
          ? -1
          : a.m.date_created! > b.m.date_created!
            ? 1
            : a.i - b.i,
      )
      .map((x) => x.m);
    const segments: SessionMessage[][] = [];
    let current: SessionMessage[] = [];
    msgs.forEach((m, i) => {
      if (current.length > 0 && opensSession(msgs, i)) {
        segments.push(current);
        current = [];
      }
      current.push(m);
    });
    if (current.length) segments.push(current);
    const sessions = segments.map((seg, index): ChatSession => {
      const t = conversationTimestamps(seg).get(conversation);
      return {
        conversation,
        index,
        key: `${conversation}#${index}`,
        startAt: seg[0]!.date_created!,
        endAt: seg[seg.length - 1]!.date_created!,
        isLatest: index === segments.length - 1,
        firstCustomerAt: t?.firstCustomerAt ?? null,
        firstAgentAt: t?.firstAgentAt ?? null,
        firstAgentBy: t?.firstAgentBy ?? null,
        firstAgentAnyAt: t?.firstAgentAnyAt ?? null,
        handledByMaha: t?.handledByMaha ?? false,
        mahaHandoverAt: t?.mahaHandoverAt ?? null,
        hadMaha: t?.hadMaha ?? false,
      };
    });
    out.set(conversation, sessions);
  }
  return out;
}

/**
 * Is this session inside the report's dates? A session belongs to the day it
 * STARTED, exactly as a chat belonged to the day it was created.
 */
export function sessionInRange(
  s: Pick<ChatSession, 'startAt'>,
  from: string | null | undefined,
  toInclusive: string | null | undefined,
): boolean {
  /* Compared as instants, the way the conversation query compares them: a
     bare `YYYY-MM-DD` reads as that day's 00:00 UTC, like Directus reads it. */
  const at = Date.parse(s.startAt);
  if (from && at < Date.parse(from)) return false;
  if (toInclusive && at > Date.parse(toInclusive)) return false;
  return true;
}

/** The conversation columns a session row is built from. */
export interface SessionConversation {
  id: string;
  status: string | null;
  assigned_agent: string | null;
  solved_at: string | null;
  date_created: string | null;
  initiated_by?: string | null;
}

/** One report row: a SESSION of a chat thread. */
export interface SessionTimingRow<C extends SessionConversation> {
  conversation: C;
  conversationId: string;
  /** Unique per row - the React key and the CSV row identity. */
  sessionKey: string;
  sessionIndex: number;
  isLatestSession: boolean;
  /** When the NEXT session of this thread started; null for the newest one. */
  nextSessionAt: string | null;
  agentId: string | null;
  firstCustomerAt: string | null;
  firstAgentAt: string | null;
  firstAgentBy: string | null;
  solvedAt: string | null;
  startedAt: string | null;
  initiatedBy: 'agent' | 'customer';
  firstOutreachAt: string | null;
  /**
   * Maha resolved this session herself (2026-11-09). Such sessions are NOT in
   * `sessionTimingRows` - they are nobody's to answer - and are counted by
   * `mahaSessionStats` instead.
   */
  handledByMaha?: boolean;
}

/**
 * Every in-range SESSION of the given conversations, as report rows.
 *
 *  - WHO: the newest session belongs to the chat's assignee (else whoever
 *    answered it), as the chat row always did; an EARLIER session belongs to
 *    the agent who answered it - the assignee now may never have seen it.
 *  - SOLVED: the newest session uses the chat's own status; an earlier one was
 *    necessarily solved (a chat reopens only from solved), at its last message.
 *  - WHO OPENED IT: only the first session can be an agent's outreach.
 *  - A conversation with no messages at all is still one row, on its creation
 *    day, so a chat nobody wrote in does not vanish from the totals.
 */
export function sessionTimingRows<C extends SessionConversation>(
  conversations: readonly C[],
  messages: readonly SessionMessage[],
  range: { from?: string | null; to?: string | null },
  isSolved: (status: string | null) => boolean,
): SessionTimingRow<C>[] {
  const sessions = chatSessions(messages);
  const rows: SessionTimingRow<C>[] = [];
  for (const c of conversations) {
    const list = sessions.get(c.id);
    if (!list || list.length === 0) {
      if (!c.date_created || !sessionInRange({ startAt: c.date_created }, range.from, range.to)) {
        continue;
      }
      rows.push({
        conversation: c,
        conversationId: c.id,
        sessionKey: `${c.id}#0`,
        sessionIndex: 0,
        isLatestSession: true,
        nextSessionAt: null,
        agentId: c.assigned_agent ?? null,
        firstCustomerAt: null,
        firstAgentAt: null,
        firstAgentBy: null,
        solvedAt: isSolved(c.status) ? c.solved_at : null,
        startedAt: c.date_created,
        initiatedBy: c.initiated_by === 'agent' ? 'agent' : 'customer',
        firstOutreachAt: null,
      });
      continue;
    }
    list.forEach((s, i) => {
      const startedAt = i === 0 ? (c.date_created ?? s.startAt) : s.startAt;
      if (!sessionInRange({ startAt: startedAt }, range.from, range.to)) return;
      // Maha resolved it: nobody's to answer, so in no agent's numbers.
      if (s.handledByMaha) return;
      rows.push({
        conversation: c,
        conversationId: c.id,
        sessionKey: s.key,
        sessionIndex: s.index,
        isLatestSession: s.isLatest,
        nextSessionAt: list[i + 1]?.startAt ?? null,
        agentId: s.isLatest ? (c.assigned_agent ?? s.firstAgentBy) : s.firstAgentBy,
        firstCustomerAt: s.firstCustomerAt,
        firstAgentAt: s.firstAgentAt,
        firstAgentBy: s.firstAgentBy,
        solvedAt: s.isLatest ? (isSolved(c.status) ? c.solved_at : null) : s.endAt,
        startedAt,
        initiatedBy: i === 0 && c.initiated_by === 'agent' ? 'agent' : 'customer',
        firstOutreachAt: i === 0 ? s.firstAgentAnyAt : null,
      });
    });
  }
  return rows;
}

/**
 * The customer rating that belongs to ONE session row: the latest one given
 * between that session's start and the next session's start. Ratings are
 * stored per thread, so without this a returning customer's single rating was
 * counted once for every session.
 */
export function sessionRating(
  row: Pick<SessionTimingRow<SessionConversation>, 'startedAt' | 'nextSessionAt'>,
  ratings: ReadonlyArray<{ score: number; at: string | null }> | undefined,
): number | null {
  if (!ratings?.length) return null;
  const from = row.startedAt ? Date.parse(row.startedAt) : -Infinity;
  const to = row.nextSessionAt ? Date.parse(row.nextSessionAt) : Infinity;
  let best: { score: number; t: number } | null = null;
  for (const r of ratings) {
    const t = r.at ? Date.parse(r.at) : NaN;
    if (!Number.isFinite(t)) {
      // An undated rating can only be placed on the newest session.
      if (row.nextSessionAt === null && !best) best = { score: r.score, t: -Infinity };
      continue;
    }
    if (t >= from && t < to && (!best || t >= best.t)) best = { score: r.score, t };
  }
  return best ? best.score : null;
}

/**
 * MAHA'S OWN NUMBERS (owner, 2026-11-09): of the in-range sessions she took,
 * how many she resolved alone and how many went to people (and when).
 */
export function mahaSessionStats(
  messages: readonly SessionMessage[],
  range: { from?: string | null; to?: string | null },
): { taken: number; handledByMaha: number; handedOver: number } {
  let taken = 0;
  let handledByMaha = 0;
  let handedOver = 0;
  const mahaConvs = new Set(
    messages
      .filter((m) => m.source === 'maha_intro' || m.source === 'maha')
      .map((m) => m.conversation),
  );
  const sessions = chatSessions(messages.filter((m) => mahaConvs.has(m.conversation)));
  for (const list of sessions.values()) {
    for (const s of list) {
      if (!sessionInRange(s, range.from, range.to)) continue;
      if (!s.hadMaha) continue;
      taken += 1;
      if (s.handledByMaha) handledByMaha += 1;
      else handedOver += 1;
    }
  }
  return { taken, handledByMaha, handedOver };
}
