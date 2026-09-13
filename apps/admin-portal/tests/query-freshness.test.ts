import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

/**
 * THE ADMIN PORTAL MUST NOT NEED A RELOAD.
 *
 * REPORTED (owner, 2026-09-13): a customer rated a chat 4 stars, the rating was
 * stored correctly — verified in `csat_responses` on production — and the
 * dashboard still read "no rating yet". Nothing was broken server-side: the
 * portal was simply showing what it had fetched when the page loaded.
 *
 * Unlike the agent portal it has no socket, and opening one for dashboards and
 * approval queues is heavy machinery for data that changes by the second rather
 * than the millisecond. So freshness is set once on the client instead of at 41
 * separate call sites, each of which would otherwise decide for itself — which
 * is how one screen ends up live and the next one stale.
 */
describe('admin portal query defaults', () => {
  /** Mirrors the QueryClient built in main.tsx. */
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        staleTime: 10_000,
      },
    },
  });
  const d = client.getDefaultOptions().queries!;

  it('polls, so a screen left open updates itself', () => {
    expect(d.refetchInterval).toBe(30_000);
  });

  it('STOPS polling in a hidden tab', () => {
    // An admin with the portal open on a second monitor all day must not fire a
    // request every 30 seconds against a shared Directus for a tab nobody is
    // looking at.
    expect(d.refetchIntervalInBackground).toBe(false);
  });

  it('refreshes the moment the operator comes back to the tab', () => {
    // The pair to the line above: polling pauses when hidden, so returning is
    // exactly when the data must catch up.
    expect(d.refetchOnWindowFocus).toBe(true);
  });

  it('keeps a short stale floor so screens do not stampede', () => {
    // Several components asking for the same data, or a quick hop between
    // pages, should not fan out into duplicate requests.
    expect(d.staleTime).toBe(10_000);
    expect(d.staleTime as number).toBeLessThan(d.refetchInterval as number);
  });

  it('lets a slower query override the default', () => {
    // Reports and month aggregates set their own staleTime; a per-query value
    // must always win, or this change would make expensive screens poll hard.
    const merged = { ...d, staleTime: 60 * 60_000 };
    expect(merged.staleTime).toBe(3_600_000);
  });
});
