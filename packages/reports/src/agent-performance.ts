/**
 * Agent performance, measured on CHATS.
 *
 * Two numbers the operations team asked for, both about the conversation and
 * neither about the ticket:
 *
 *   first response  the agent's first reply, measured from the customer's
 *                   first message — not from when the chat row was created,
 *                   which is the same instant only for chats the customer
 *                   opened by speaking first.
 *   time to solve   from the customer's first message to the moment the chat
 *                   was marked solved.
 *
 * Two rules run through everything here:
 *
 * 1. A chat with no agent reply has NO first-response time. It is counted and
 *    reported separately, never as a zero and never silently dropped: averaging
 *    it away as 0 would make the worst cases improve the number, and dropping
 *    it would hide them completely.
 * 2. Every average carries the count it came from. An average over three chats
 *    and one over three hundred must not look identical on a dashboard.
 */

/** One chat, reduced to the timestamps these measures need. */
export interface ChatTiming {
  conversationId: string;
  /** Directus id of the agent the chat is assigned to, or null. */
  agentId: string | null;
  /** Display name for that agent, resolved by the caller. */
  agentName: string;
  /** ISO time of the customer's first message. Null if they never wrote. */
  firstCustomerAt: string | null;
  /** ISO time of the agent's first reply. Null if nobody answered. */
  firstAgentAt: string | null;
  /** ISO time the chat was marked solved. Null while it is still open. */
  solvedAt: string | null;
  /**
   * True when the auto-assignment ladder passed this chat on before anybody
   * answered it. Such a chat leaves the personal first-response population —
   * see the note on `ownChats`. Absent is treated as false, so a caller that
   * does not read routing events gets exactly the old behaviour.
   */
  passedOn?: boolean;
  /** The agent who picked it up AFTER it had been passed on, if any. */
  takenBy?: string | null;
}

export interface AgentPerformanceRow {
  agentId: string | null;
  agentName: string;
  /** Chats in range assigned to this agent. */
  chats: number;
  /** Chats where an agent replied at all. */
  answered: number;
  /**
   * Chats with no agent reply AT ALL — passed on or not. Reported, never
   * averaged in. Whether a customer has been answered is a fact rather than a
   * judgement about speed, so unlike the timings it is not scoped to `ownChats`.
   */
  unanswered: number;
  /**
   * Chats this agent was given cleanly and nobody had to chase — the ONLY
   * population the first-response figures below describe.
   *
   * A chat the ladder passed on carries the seconds the previous agents spent
   * not answering it, because first response is measured from the customer's
   * message and the customer does not care how many people it went through.
   * Charging that to whoever happened to be third measures the ladder rather
   * than the agent, so those chats are counted under `commonChats` instead.
   */
  ownChats: number;
  /**
   * Chats this agent picked up after somebody else had let them go.
   *
   * The number worth competing over: it is invisible in a response-time
   * average, and it rewards exactly the behaviour a shared queue needs.
   */
  commonChats: number;
  /** Chats marked solved in range. */
  solved: number;
  /** Mean seconds to first reply, over `answered` chats. Null when none. */
  avgFirstResponseSec: number | null;
  /** Median, which a single very old chat cannot drag. Null when none. */
  medianFirstResponseSec: number | null;
  /** Mean seconds from first message to solved, over `solved`. Null when none. */
  avgTimeToSolveSec: number | null;
  medianTimeToSolveSec: number | null;
}

const secondsBetween = (from: string, to: string): number | null => {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = (b - a) / 1000;
  // A negative duration means the timestamps disagree about order — a clock
  // skew or a repaired row. Reporting it as a fast reply would be a lie in the
  // flattering direction, so it is discarded rather than clamped to zero.
  return d < 0 ? null : d;
};

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** First response for one chat, or null when it cannot be measured. */
export function firstResponseSec(c: ChatTiming): number | null {
  if (!c.firstCustomerAt || !c.firstAgentAt) return null;
  return positiveOrNull(secondsBetween(c.firstCustomerAt, c.firstAgentAt));
}

/**
 * A duration, or null when the clock ran backwards.
 *
 * Real data has chats marked solved BEFORE the customer's first message — a
 * reopened chat, a bad import, a clock skew. One of them is worth about minus
 * twenty-five days, and a mean is happy to swallow that: the daily average
 * drops below zero and the trend line leaves the chart, which reads as a
 * rendering fault rather than as a bad row. A negative elapsed time is not a
 * slow measurement, it is no measurement.
 */
function positiveOrNull(sec: number | null): number | null {
  return sec == null || sec < 0 ? null : sec;
}

/** Time to solve for one chat, or null when it is unsolved or unmeasurable. */
export function timeToSolveSec(c: ChatTiming): number | null {
  if (!c.firstCustomerAt || !c.solvedAt) return null;
  return positiveOrNull(secondsBetween(c.firstCustomerAt, c.solvedAt));
}

/**
 * Whether a chat met the promise, given a first-response target in seconds.
 *
 * A chat NOBODY answered has missed — that is the whole point of tracking it.
 * Returning "unknown" for those would let the worst cases sit outside both
 * populations and quietly improve the met-rate.
 */
export function metFirstResponse(c: ChatTiming, targetSec: number): boolean {
  const sec = firstResponseSec(c);
  if (sec === null) return false;
  return sec <= targetSec;
}

/** Group chats by agent and reduce each group to one row. */
export function agentPerformance(chats: readonly ChatTiming[]): AgentPerformanceRow[] {
  const groups = new Map<string, ChatTiming[]>();
  for (const c of chats) {
    // Unassigned chats are their own row rather than being dropped: work nobody
    // picked up is exactly what a supervisor is looking for.
    const key = c.agentId ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const rows: AgentPerformanceRow[] = [];
  for (const [key, group] of groups) {
    const agentId = key === '' ? null : key;
    // The response-time figures describe chats this agent got cleanly. See
    // `ownChats` for why a passed-on chat cannot fairly sit in this population.
    const own = group.filter((c) => !c.passedOn);
    const responses = own.map(firstResponseSec).filter((n): n is number => n !== null);
    const solves = group.map(timeToSolveSec).filter((n): n is number => n !== null);
    rows.push({
      agentId,
      // Never blank: a row whose agent has no name is unreadable, and the
      // caller cannot always resolve one (an account with no name set, a
      // /users read that failed, a chat assigned to a filtered-out account).
      agentName: group[0]!.agentName?.trim() || group[0]!.agentId || 'Unassigned',
      chats: group.length,
      answered: responses.length,
      // Every chat with no reply, passed on or not — see the note in
      // performanceSummary. Only the timings below are scoped to `own`.
      unanswered: group.filter((c) => firstResponseSec(c) === null).length,
      ownChats: own.length,
      // Credited from the routing history, not from who currently holds the
      // chat: the ladder may hand it on again afterwards.
      commonChats: agentId ? chats.filter((c) => c.takenBy === agentId).length : 0,
      solved: group.filter((c) => !!c.solvedAt).length,
      avgFirstResponseSec: mean(responses),
      medianFirstResponseSec: median(responses),
      avgTimeToSolveSec: mean(solves),
      medianTimeToSolveSec: median(solves),
    });
  }
  // Busiest first: a supervisor reads this to find where the load is.
  return rows.sort((a, b) => b.chats - a.chats || a.agentName.localeCompare(b.agentName));
}

/** Split chats into the two populations the report shows side by side. */
export function splitBySla(
  chats: readonly ChatTiming[],
  targetSec: number,
): { met: ChatTiming[]; missed: ChatTiming[] } {
  const met: ChatTiming[] = [];
  const missed: ChatTiming[] = [];
  for (const c of chats) (metFirstResponse(c, targetSec) ? met : missed).push(c);
  return { met, missed };
}

/** `92` -> "1m 32s". Null renders as a dash by the caller, never as "0s". */
export function formatDuration(sec: number | null): string | null {
  if (sec === null) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
