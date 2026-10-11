import type { BusyPeriod } from '../../lib/job-producer.js';

/**
 * BUSY TIME (owner, 2026-10-11): how often each agent used Busy, for how long,
 * and when. A period still open is measured up to `now` and marked ongoing.
 */
export interface BusyRow extends BusyPeriod {
  durationSec: number;
  ongoing: boolean;
}

export function toRows(periods: readonly BusyPeriod[], now: number = Date.now()): BusyRow[] {
  return periods
    .map((p) => {
      const start = Date.parse(p.started_at);
      const end = p.ended_at ? Date.parse(p.ended_at) : now;
      return {
        ...p,
        durationSec: Number.isFinite(start) ? Math.max(0, Math.round((end - start) / 1000)) : 0,
        ongoing: !p.ended_at,
      };
    })
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export interface BusySummary {
  agent: string | null;
  times: number;
  totalSec: number;
  longestSec: number;
  lastStartedAt: string | null;
}

export function summarize(rows: readonly BusyRow[]): BusySummary[] {
  const by = new Map<string, BusySummary>();
  for (const r of rows) {
    const key = r.agent ?? '';
    const cur = by.get(key) ?? {
      agent: r.agent,
      times: 0,
      totalSec: 0,
      longestSec: 0,
      lastStartedAt: null,
    };
    cur.times += 1;
    cur.totalSec += r.durationSec;
    cur.longestSec = Math.max(cur.longestSec, r.durationSec);
    if (!cur.lastStartedAt || r.started_at > cur.lastStartedAt) cur.lastStartedAt = r.started_at;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.totalSec - a.totalSec);
}
