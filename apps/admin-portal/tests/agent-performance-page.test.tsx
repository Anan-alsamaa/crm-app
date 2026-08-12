import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(val));
        }
      }
      return s;
    },
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

const sdk = vi.hoisted(() => ({
  request: vi.fn(),
}));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: sdk.request } }));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, query: unknown) => ({ kind: 'items', collection, query }),
  readUsers: (query: unknown) => ({ kind: 'users', query }),
}));

import { AgentPerformancePage } from '../src/features/performance/AgentPerformancePage.js';

const conversations = [
  // Answered in 1 minute.
  { id: 'fast', status: 'solved', assigned_agent: 'a1', solved_at: '2026-08-13T10:30:00.000Z' },
  // Answered in 20 minutes.
  { id: 'slow', status: 'solved', assigned_agent: 'a1', solved_at: '2026-08-13T10:40:00.000Z' },
  // Nobody answered, and nobody picked it up either.
  { id: 'never', status: 'open', assigned_agent: null, solved_at: null },
];

const messages = [
  { conversation: 'fast', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
  { conversation: 'fast', sender_type: 'agent', date_created: '2026-08-13T10:01:00.000Z' },
  { conversation: 'slow', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
  { conversation: 'slow', sender_type: 'agent', date_created: '2026-08-13T10:20:00.000Z' },
  { conversation: 'never', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<AgentPerformancePage />, { wrapper: Wrapper });
}

const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

beforeEach(() => {
  sdk.request.mockReset();
  sdk.request.mockImplementation((req: { kind: string; collection?: string }) => {
    if (req.kind === 'users')
      return Promise.resolve([{ id: 'a1', first_name: 'Sara', email: 'sara@yiji.test' }]);
    if (req.collection === 'conversations') return Promise.resolve(conversations);
    if (req.collection === 'messages') return Promise.resolve(messages);
    return Promise.resolve([]);
  });
});

describe('admin AgentPerformancePage', () => {
  it('computes the same two populations a supervisor sees in the user portal', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Not meeting SLA/ })).toHaveTextContent('2'),
    );
    expect(screen.getByRole('button', { name: /Meeting SLA/ })).toHaveTextContent('1');
  });

  it('gives work nobody picked up its own row rather than dropping it', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const unassigned = within(row('Unassigned')).getAllByRole('cell');
    expect(unassigned[1]).toHaveTextContent('1');
    expect(unassigned[2]).toHaveTextContent('1');
  });

  it('excludes internal notes from the first-response measure', async () => {
    sdk.request.mockImplementation((req: { kind: string; collection?: string; query?: never }) => {
      if (req.kind === 'users') return Promise.resolve([{ id: 'a1', first_name: 'Sara' }]);
      if (req.collection === 'conversations') return Promise.resolve(conversations);
      if (req.collection === 'messages') return Promise.resolve(messages);
      return Promise.resolve([]);
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const call = sdk.request.mock.calls.find(
      (c) => (c[0] as { collection?: string }).collection === 'messages',
    )!;
    // A note is the team talking to itself — counting one as a reply would
    // report a customer as answered when nobody has spoken to them.
    expect((call[0] as { query: { filter: Record<string, unknown> } }).query.filter).toMatchObject({
      is_internal_note: { _eq: false },
    });
  });

  it('is read only: no row navigates anywhere', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    for (const r of screen.getAllByRole('row')) {
      expect(r).not.toHaveAttribute('href');
      expect(r.className).not.toContain('cursor-pointer');
    }
  });

  it('re-reads rather than re-filters when the date range changes', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const before = sdk.request.mock.calls.length;
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    await waitFor(() => expect(sdk.request.mock.calls.length).toBeGreaterThan(before));
    const call = sdk.request.mock.calls
      .reverse()
      .find((c) => (c[0] as { collection?: string }).collection === 'conversations')!;
    expect(JSON.stringify((call[0] as { query: unknown }).query)).toContain('2026-08-01');
  });

  it('says nothing matched instead of drawing an empty table', async () => {
    sdk.request.mockImplementation((req: { kind: string }) =>
      Promise.resolve(req.kind === 'users' ? [{ id: 'a1', first_name: 'Sara' }] : []),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No chats match these filters/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
