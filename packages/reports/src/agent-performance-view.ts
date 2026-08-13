import {
  agentPerformance,
  firstResponseSec,
  metFirstResponse,
  timeToSolveSec,
  type ChatTiming,
} from './agent-performance.js';

/**
 * The shapes the agent-performance PAGE draws, computed once.
 *
 * Both portals render this report and they must never disagree about a number,
 * so the arithmetic lives here and each app supplies only its own JSX. What
 * differs between them is what a row does when you click it — not what it says.
 *
 * The volume series exists for a reason worth stating: on a quiet range, or one
 * where chats went unanswered, every response-time chart is legitimately empty.
 * A page of empty charts reads as broken. Chats-handled is always countable, so
 * the charts always carry at least one honest line, and the missing timings are
 * visibly missing rather than indistinguishable from a rendering failure.
 */

export interface PerformanceSummary {
  chats: number;
  answered: number;
  solved: number;
  avgFirstResponseSec: number | null;
  medianFirstResponseSec: number | null;
  avgTimeToSolveSec: number | null;
  /** Percentage of chats answered inside the target. Null when none are decided. */
  metPct: number | null;
  /**
   * Chats with no agent reply at all — passed on or not. A fact, not a
   * judgement, so nothing is scoped out of it.
   */
  unanswered: number;
  /**
   * Chats nobody answered first time, that somebody then picked up.
   *
   * Kept out of the response-time figures above: a chat that has been passed
   * along carries the seconds the earlier agents spent not answering it, so
   * scoring whoever took it against the same target measures the ladder rather
   * than the person. Counted here instead, where picking one up reads as the
   * good deed it is.
   */
  commonChats: number;
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/** The headline numbers, over whatever population is passed in. */
export function performanceSummary(
  chats: readonly ChatTiming[],
  targetSec: number,
): PerformanceSummary {
  const firsts: number[] = [];
  const solves: number[] = [];
  let unanswered = 0;
  let solved = 0;
  let met = 0;
  let ownChats = 0;
  let commonChats = 0;

  for (const c of chats) {
    if (c.takenBy) commonChats += 1;
    const ts = timeToSolveSec(c);
    if (ts != null) {
      solves.push(ts);
      solved += 1;
    }
    /**
     * "Nobody has answered this" counts EVERY chat, passed on or not.
     *
     * Only the response-time figures and the met-rate are scoped to chats the
     * agent got cleanly — those are judgements about how fast somebody was, and
     * a chat carrying two other agents' delay cannot fairly be one. Whether a
     * customer has been answered at all is not a judgement, it is a fact, and
     * it is the single most important thing on the page. Scoping it the same
     * way made a chat that went round the whole ladder unanswered disappear
     * from both this count and the common-chat count — the worst outcome in the
     * system, invisible.
     */
    if (firstResponseSec(c) == null) unanswered += 1;
    if (c.passedOn) continue;
    ownChats += 1;
    const fr = firstResponseSec(c);
    if (fr != null) firsts.push(fr);
    if (metFirstResponse(c, targetSec)) met += 1;
  }

  return {
    chats: chats.length,
    answered: firsts.length,
    unanswered,
    solved,
    commonChats,
    avgFirstResponseSec: mean(firsts),
    medianFirstResponseSec: median(firsts),
    avgTimeToSolveSec: mean(solves),
    // Over every chat the agent got CLEANLY, not only the answered ones: a chat
    // nobody replied to missed the target as surely as a slow one, and
    // excluding it would let the worst outcomes quietly improve the percentage.
    metPct: ownChats === 0 ? null : Math.round((met / ownChats) * 100),
  };
}

export interface ComparisonRow {
  label: string;
  agentId: string | null;
  note: string;
  values: {
    chats: number;
    /** Chats picked up after somebody else let them go — the competitive one. */
    common: number;
    first: number | null;
    solve: number | null;
  };
}

/**
 * One row per agent for the comparison chart, busiest first.
 *
 * `noteFor` formats the count in the caller's language; the count itself is not
 * optional, because an average without the number it came from invites reading
 * one lucky chat as a trend.
 */
export function comparisonRows(
  chats: readonly ChatTiming[],
  noteFor: (n: number) => string,
): ComparisonRow[] {
  return agentPerformance(chats).map((r) => ({
    label: r.agentName,
    agentId: r.agentId,
    note: noteFor(r.chats),
    values: {
      chats: r.chats,
      common: r.commonChats,
      first: r.avgFirstResponseSec,
      solve: r.avgTimeToSolveSec,
    },
  }));
}

export interface DailyPoint {
  /** `MM-DD`, ready to draw. */
  label: string;
  /** Full `YYYY-MM-DD`, for sorting and for anything that needs the year. */
  day: string;
  values: { chats: number; first: number | null; solve: number | null };
}

/** `2026-08-13T…` → `2026-08-13` in LOCAL time. */
function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Per-day volume and averages, oldest first.
 *
 * A day is placed by when the CUSTOMER first wrote, falling back to when the
 * chat was created — never by when it was solved, which would move a Monday
 * complaint into Thursday's column and make a bad Monday invisible.
 */
export function dailyTrend(
  chats: ReadonlyArray<ChatTiming & { startedAt?: string | null }>,
): DailyPoint[] {
  const byDay = new Map<string, { chats: number; first: number[]; solve: number[] }>();
  for (const c of chats) {
    const key = dayKey(c.firstCustomerAt ?? c.startedAt ?? null);
    if (!key) continue;
    const b = byDay.get(key) ?? { chats: 0, first: [], solve: [] };
    b.chats += 1;
    const fr = firstResponseSec(c);
    const ts = timeToSolveSec(c);
    if (fr != null) b.first.push(fr);
    if (ts != null) b.solve.push(ts);
    byDay.set(key, b);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({
      day,
      // Day and month only: the year is the same on every point and eats the
      // width the dates need.
      label: day.slice(5),
      values: { chats: v.chats, first: mean(v.first), solve: mean(v.solve) },
    }));
}
