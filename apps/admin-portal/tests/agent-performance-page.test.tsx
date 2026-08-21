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

const day = { date_created: '2026-08-13T09:59:00.000Z' };
const conversations = [
  // Answered in 1 minute.
  {
    id: 'fast',
    status: 'solved',
    assigned_agent: 'a1',
    solved_at: '2026-08-13T10:30:00.000Z',
    ...day,
  },
  // Answered in 20 minutes.
  {
    id: 'slow',
    status: 'solved',
    assigned_agent: 'a1',
    solved_at: '2026-08-13T10:40:00.000Z',
    ...day,
  },
  // Nobody answered, and nobody picked it up either.
  { id: 'never', status: 'open', assigned_agent: null, solved_at: null, ...day },
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

const row = (name: string) =>
  within(screen.getByRole('table', { name: 'Totals per agent' })).getByRole('row', {
    name: new RegExp(name),
  });

/** The headline number under a given tile label, read from the named landmark. */
function tile(label: string): string {
  const summary = screen.getByRole('region', { name: 'Summary' });
  const labelEl = within(summary)
    .getAllByText((_, el) => el?.textContent?.startsWith(label) === true)
    .filter((el) => el.tagName === 'DIV' && el.querySelector('div') === null)
    .at(-1)!;
  return labelEl.parentElement!.firstElementChild!.textContent!;
}

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
  it('reports the same headline numbers an agent sees in the user portal', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Summary' })).toBeInTheDocument(),
    );
    expect(tile('Chats')).toBe('3');
    expect(tile('No reply yet')).toBe('1');
    // 1m and 20m over the two ANSWERED chats — the unanswered one is not a 0.
    expect(tile('First response')).toBe('10m 30s');
    // One of THREE met the 5-minute target; a chat nobody answered missed it.
    expect(tile('Answered in time')).toBe('33%');
  });

  it('charts the work by volume and by speed, never on one shared axis', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Where the chats sat')).toBeInTheDocument());
    // A count and an average in seconds sharing a scale would draw "3 chats"
    // as an invisible sliver next to "10m 30s".
    const volume = screen.getByText('Where the chats sat').closest('section')!;
    expect(within(volume).getByText('Sara')).toBeInTheDocument();
    expect(screen.getByText('How fast they replied')).toBeInTheDocument();
    expect(screen.getByText('Chats per day')).toBeInTheDocument();
    expect(screen.getByText('Response times per day')).toBeInTheDocument();
  });

  it('gives work nobody picked up its own row rather than dropping it', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Totals per agent' })).toBeInTheDocument(),
    );
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
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Totals per agent' })).toBeInTheDocument(),
    );
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
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Totals per agent' })).toBeInTheDocument(),
    );
    for (const r of screen.getAllByRole('row')) {
      expect(r).not.toHaveAttribute('href');
      expect(r.className).not.toContain('cursor-pointer');
    }
  });

  it('re-reads rather than re-filters when the date range changes', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Totals per agent' })).toBeInTheDocument(),
    );
    const before = sdk.request.mock.calls.length;
    // dd/mm/yyyy in, ISO out — see the SLA report test for why.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '01/08/2026' } });
    await waitFor(() => expect(sdk.request.mock.calls.length).toBeGreaterThan(before));
    const call = sdk.request.mock.calls
      .reverse()
      .find((c) => (c[0] as { collection?: string }).collection === 'conversations')!;
    expect(JSON.stringify((call[0] as { query: unknown }).query)).toContain('2026-08-01');
  });

  it('says nothing matched instead of drawing empty charts', async () => {
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
