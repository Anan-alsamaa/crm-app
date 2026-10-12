import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * LIKE THE USER PORTAL (owner, 2026-10-12): "the agent performance page takes
 * time to load. also in the admin portal, agent performance page, we need it
 * like the user portal, we need a search by orderid, ticket id, coupon code and
 * stuff. then we need 3 different: chats, tickets, coupons".
 */

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

const sdk = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: sdk.request } }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, query: unknown) => ({ kind: 'items', collection, query }),
  readUsers: (query: unknown) => ({ kind: 'users', query }),
}));

import { AgentPerformancePage } from '../src/features/performance/AgentPerformancePage.js';

type Req = { kind: string; collection?: string; query?: Record<string, unknown> };

const day = { date_created: '2026-08-13T09:59:00.000Z' };
const conversations = [
  {
    id: 'fast',
    status: 'solved',
    assigned_agent: 'a1',
    solved_at: '2026-08-13T10:30:00.000Z',
    last_order_id: 'ORD-777',
    contact: { id: 'c1', name: null, phone: '0501234567' },
    ...day,
  },
  {
    id: 'slow',
    status: 'solved',
    assigned_agent: 'a1',
    solved_at: '2026-08-13T10:40:00.000Z',
    last_order_id: 'ORD-888',
    contact: null,
    ...day,
  },
  { id: 'never', status: 'open', assigned_agent: null, solved_at: null, ...day },
];
const messages = [
  { conversation: 'fast', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
  { conversation: 'fast', sender_type: 'agent', date_created: '2026-08-13T10:01:00.000Z' },
  { conversation: 'slow', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
  { conversation: 'slow', sender_type: 'agent', date_created: '2026-08-13T10:20:00.000Z' },
];

const tickets = [
  {
    id: 4417,
    subject: 'Late delivery',
    complaint_type: 'Late order',
    order_id: 'ORD-1001',
    status: 'solved',
    assigned_agent: 'a1',
    user_created: 'a1',
    date_created: '2026-08-13T10:00:00.000Z',
    resolved_at: '2026-08-13T11:00:00.000Z',
    closed_at: null,
    customer_phone: null,
    contact: { id: 'c1', name: 'Huda', phone: '0501234567' },
  },
  {
    id: 4418,
    subject: 'Missing item',
    complaint_type: null,
    order_id: 'ORD-2002',
    status: 'open',
    assigned_agent: 'a1',
    user_created: 'a1',
    date_created: '2026-08-13T12:00:00.000Z',
    resolved_at: null,
    closed_at: null,
    customer_phone: '+966559876543',
    contact: null,
  },
];

const coupons = [
  {
    id: 'k1',
    coupon_code: 'COMP50',
    coupon_value: 50,
    coupon_percent: null,
    discount_category: 'Amount',
    status: 'approved',
    date_created: '2026-08-13T10:30:00.000Z',
    order_id: 'ORD-1001',
    customer_phone: '0501234567',
    ticket: { id: 4417, subject: 'Late delivery', order_id: 'ORD-1001', complaint_type: null },
    contact: null,
    requested_by: { id: 'a1', first_name: 'Sara', email: null },
  },
  {
    id: 'k2',
    coupon_code: 'SORRY20',
    coupon_value: 20,
    coupon_percent: null,
    discount_category: 'Amount',
    status: 'pending',
    date_created: '2026-08-13T12:30:00.000Z',
    order_id: null,
    customer_phone: '0559876543',
    ticket: null,
    contact: null,
    requested_by: { id: 'a1', first_name: 'Sara', email: null },
  },
];

/** Every collection the three tabs read, answered by what the query asks for. */
function serve(req: Req) {
  const q = (req.query ?? {}) as { filter?: Record<string, unknown>; fields?: unknown[] };
  if (req.kind === 'users')
    return Promise.resolve([{ id: 'a1', first_name: 'Sara', email: 'sara@yiji.test' }]);
  if (req.collection === 'conversations') return Promise.resolve(conversations);
  if (req.collection === 'messages') return Promise.resolve(messages);
  if (req.collection === 'tickets') {
    // The Chats tab's "what was it about" read is by conversation.
    if (q.filter && 'conversation' in q.filter) return Promise.resolve([]);
    return Promise.resolve(tickets);
  }
  if (req.collection === 'coupon_approvals') {
    if (q.filter && 'ticket' in q.filter)
      return Promise.resolve([{ ticket: 4417, coupon_code: 'COMP50', status: 'approved' }]);
    // The best-effort extras name a single field beside `id`.
    if (q.fields?.length === 2) return Promise.resolve([]);
    return Promise.resolve(coupons);
  }
  return Promise.resolve([]);
}

function renderPage(url = '/agent-performance') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return render(<AgentPerformancePage />, { wrapper: Wrapper });
}

const calls = (collection: string) =>
  sdk.request.mock.calls.map((c) => c[0] as Req).filter((r) => r.collection === collection);

/** Body rows of a named table (the header row excluded). */
const bodyRows = (name: string) =>
  within(screen.getByRole('table', { name })).getAllByRole('row').slice(1);

beforeEach(() => {
  sdk.request.mockReset();
  sessionStorage.clear();
  sdk.request.mockImplementation(serve);
});

describe('admin agent performance — search and the three tabs', () => {
  it('opens on yesterday through today, not on all time', async () => {
    renderPage();
    await waitFor(() => expect(calls('conversations').length).toBeGreaterThan(0));
    // All time read every chat ever, then every message of each — the main
    // reason the page was slow.
    const query = JSON.stringify(calls('conversations')[0]!.query);
    expect(query).toContain('_gte');
    expect(query).toContain('_lte');
  });

  it('loads only the open tab: no ticket or coupon list read on the Chats tab', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Chat by chat' })).toBeInTheDocument(),
    );
    expect(calls('coupon_approvals')).toHaveLength(0);
    expect(calls('tickets').every((r) => JSON.stringify(r.query).includes('"conversation"'))).toBe(
      true,
    );
    const chatReads = calls('conversations').length;

    fireEvent.click(screen.getByRole('tab', { name: 'Tickets' }));
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Ticket by ticket' })).toBeInTheDocument(),
    );
    // Leaving the Chats tab does not re-read the chats.
    expect(calls('conversations')).toHaveLength(chatReads);
  });

  it('finds a chat by order id or phone, and the tiles keep counting the whole range', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Chat by chat' })).toBeInTheDocument(),
    );
    expect(bodyRows('Chat by chat')).toHaveLength(3);
    const search = screen.getByLabelText('Search');
    fireEvent.change(search, { target: { value: 'ord-777' } });
    await waitFor(() => expect(bodyRows('Chat by chat')).toHaveLength(1));
    expect(bodyRows('Chat by chat')[0]).toHaveTextContent('#ORD-777');

    // Cleared first, so the phone match below is its own result, not the last one.
    fireEvent.change(search, { target: { value: '' } });
    await waitFor(() => expect(bodyRows('Chat by chat')).toHaveLength(3));
    fireEvent.change(search, { target: { value: '+966 50 123 4567' } });
    await waitFor(() => expect(bodyRows('Chat by chat')).toHaveLength(1));
    expect(bodyRows('Chat by chat')[0]).toHaveTextContent('#ORD-777');

    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(within(summary).getAllByText('3').length).toBeGreaterThan(0);
  });

  it('says so when nothing matches instead of showing an empty table', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Chat by chat' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz-none' } });
    await waitFor(() =>
      expect(screen.getByText('Nothing matches “zzz-none”.')).toBeInTheDocument(),
    );
  });

  it('Tickets tab: searchable by ticket id, order id, coupon code or phone', async () => {
    renderPage('/agent-performance?tab=tickets');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Ticket by ticket' })).toBeInTheDocument(),
    );
    expect(bodyRows('Ticket by ticket')).toHaveLength(2);
    // The linked coupon shows on its ticket.
    expect(bodyRows('Ticket by ticket')[0]).toHaveTextContent('COMP50');

    const search = screen.getByLabelText('Search');
    for (const [q, id] of [
      ['4418', '4418'],
      ['ORD-1001', '4417'],
      ['comp50', '4417'],
      ['+966 55 987 6543', '4418'],
    ] as const) {
      fireEvent.change(search, { target: { value: q } });
      // Waits for THIS query's result: the previous one also left one row.
      await waitFor(() => {
        expect(bodyRows('Ticket by ticket')).toHaveLength(1);
        expect(bodyRows('Ticket by ticket')[0]).toHaveTextContent(`ID ${id}`);
      });
    }
  });

  it('Tickets tab: one agent = tickets assigned to OR raised by them', async () => {
    sessionStorage.setItem(
      'admin-agent-performance:v2',
      JSON.stringify({ filters: { agentId: 'a1' }, tab: 'tickets' }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Ticket by ticket' })).toBeInTheDocument(),
    );
    const read = calls('tickets').find((r) => !JSON.stringify(r.query).includes('"conversation"'))!;
    expect(JSON.stringify(read.query)).toContain(
      '{"_or":[{"assigned_agent":{"_eq":"a1"}},{"user_created":{"_eq":"a1"}}]}',
    );
  });

  it('Coupons tab: stages, and search by coupon code narrows the table only', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Chat by chat' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Coupons' }));
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Coupon by coupon' })).toBeInTheDocument(),
    );
    expect(bodyRows('Coupon by coupon')).toHaveLength(2);
    expect(bodyRows('Coupon by coupon')[1]).toHaveTextContent('Waiting for approval');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'sorry20' } });
    await waitFor(() => expect(bodyRows('Coupon by coupon')).toHaveLength(1));
    expect(bodyRows('Coupon by coupon')[0]).toHaveTextContent('SORRY20');
    const summary = screen.getByRole('region', { name: 'Coupon summary' });
    expect(within(summary).getByText('2')).toBeInTheDocument();
  });

  it('keeps the review read only on the new tabs: no row opens anything', async () => {
    renderPage('/agent-performance?tab=coupons');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Coupon by coupon' })).toBeInTheDocument(),
    );
    for (const r of screen.getAllByRole('row')) expect(r.className).not.toContain('cursor-pointer');
  });
});
