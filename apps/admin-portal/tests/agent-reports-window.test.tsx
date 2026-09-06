import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

// Capture the QUERY, not the result: the bug this guards was entirely in the
// filter, and every response along the way was a perfectly valid 200.
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readUsers: (opts: unknown) => ({ collection: 'directus_users', opts }),
  aggregate: (collection: string, opts: unknown) => ({ collection, opts, aggregate: true }),
}));

import { useAgentReportData } from '../src/features/report-exports/api.js';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

interface Captured {
  collection: string;
  opts: { filter?: Record<string, unknown> };
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue([]);
});

const labels = { unassigned: 'Unassigned', noSubject: '(none)' };

describe('the ticket window', () => {
  /**
   * THE BUG THIS EXISTS FOR
   *
   * The report displays, sorts and groups by `complaint_date` — when the
   * complaint happened — while the query filtered `date_created`, when the row
   * was typed in. For tickets raised in the app the two are minutes apart and
   * nothing looks wrong. Imported history makes them months apart: 1,621 rows
   * spanning nine months landed with one creation stamp, so asking for August
   * returned 7 tickets when the honest answer was 17, and any range ending
   * before today emptied the report of everything ever imported.
   */
  it('asks for complaints that HAPPENED in the range, not rows created in it', async () => {
    renderHook(() => useAgentReportData(0, labels, { from: '2026-08-01', to: '2026-08-31' }), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(request).toHaveBeenCalled());
    const tickets = request.mock.calls
      .map(([arg]) => arg as Captured)
      .find((c) => c?.collection === 'tickets');
    expect(tickets, 'no tickets query was made').toBeTruthy();

    const filter = JSON.stringify(tickets!.opts.filter);
    expect(filter).toContain('complaint_date');
    expect(filter).toContain('2026-08-01T00:00:00');
    // Inclusive of the last day: "up to the 31st" means including the 31st.
    expect(filter).toContain('2026-08-31T23:59:59');
  });

  it('still finds older tickets that predate the complaint_date field', async () => {
    // Matching only on complaint_date would silently drop every ticket raised
    // before that field existed — they have none.
    renderHook(() => useAgentReportData(0, labels, { from: '2026-08-01', to: '2026-08-31' }), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(request).toHaveBeenCalled());
    const tickets = request.mock.calls
      .map(([arg]) => arg as Captured)
      .find((c) => c?.collection === 'tickets');

    const filter = tickets!.opts.filter as { _or?: unknown[] };
    expect(Array.isArray(filter._or), 'the window is not an _or').toBe(true);
    const asText = JSON.stringify(filter._or);
    expect(asText).toContain('_null');
    expect(asText).toContain('date_created');
  });

  it('leaves conversations and CSAT on their own timestamps', async () => {
    // Only the ticket window changed. A conversation has no complaint_date, and
    // reading one against it would return nothing at all.
    renderHook(() => useAgentReportData(0, labels, { from: '2026-08-01', to: '2026-08-31' }), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(request).toHaveBeenCalled());
    const calls = request.mock.calls.map(([arg]) => arg as Captured);

    const conversations = calls.find((c) => c?.collection === 'conversations');
    expect(JSON.stringify(conversations!.opts.filter)).toContain('date_created');
    expect(JSON.stringify(conversations!.opts.filter)).not.toContain('complaint_date');

    const csat = calls.find((c) => c?.collection === 'csat_responses');
    expect(JSON.stringify(csat!.opts.filter)).toContain('submitted_at');
  });
});
