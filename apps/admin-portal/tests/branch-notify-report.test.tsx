import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import React from 'react';
import {
  byBranch,
  bySender,
  byTicketType,
  matches,
  riyadhTime,
  sendSeconds,
  totals,
  type NotifyRow,
} from '../src/features/branch-notify-report/report.js';

/**
 * AGENT KPI -> BRANCH NOTIFICATIONS (owner, 26 Nov 2026): everything sent to
 * a branch's printer - ticket notifications and agents' custom messages - for
 * WeCare Admin and whoever opens Agent KPI.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      for (const [key, val] of Object.entries(o ?? {})) {
        if (key !== 'defaultValue')
          s = s.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(val));
      }
      return s;
    },
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

const LAB = { id: 's-lab', code: 'LCP-095', name: 'One Square RYD' };
const KHALEEJ = { id: 's-kp', code: 'LCP-009', name: 'Khaleej Plaza' };

const ROWS: NotifyRow[] = [
  {
    id: 'c1',
    kind: 'custom',
    status: 'sent',
    order_id: '1234',
    description: 'Test message.',
    date_created: '2026-11-26T10:45:49.000Z',
    sent_at: '2026-11-26T10:46:39.000Z',
    sender_name: 'Nada Al Noaima',
    sender_login: '03032',
    user_created: 'u-nada',
    attempts: 1,
    store: KHALEEJ,
  },
  {
    id: 'c2',
    kind: 'custom',
    status: 'failed',
    description: 'Please call WeCare.',
    error: 'SaraPOS 500: outlet offline',
    attempts: 5,
    date_created: '2026-11-26T09:00:00.000Z',
    sent_at: null,
    sender_name: null, // sent before the name was kept on the message
    sender_login: null,
    user_created: 'u-old',
    store: LAB,
  },
  {
    id: 't1',
    kind: null,
    status: 'sent',
    complaint_type: 'Missing item',
    order_id: '946641',
    description: 'Fries missing',
    date_created: '2026-11-26T08:00:00.000Z',
    sent_at: '2026-11-26T08:00:20.000Z',
    attempts: 1,
    store: KHALEEJ,
  },
  {
    id: 't2',
    kind: null,
    status: 'queued',
    complaint_type: 'Missing item',
    description: 'Drink missing',
    date_created: '2026-11-26T11:00:00.000Z',
    sent_at: null,
    store: LAB,
  },
];
const nameOf = (id: string | null | undefined) => (id === 'u-old' ? 'Ali Old' : null);

describe('the numbers', () => {
  it('totals split tickets from custom messages, and sent / failed / waiting', () => {
    expect(totals(ROWS)).toMatchObject({
      total: 4,
      ticket: 2,
      custom: 2,
      sent: 2,
      failed: 1,
      queued: 1,
    });
  });

  it('average time to print counts only what was printed', () => {
    expect(sendSeconds(ROWS[0]!)).toBe(50);
    expect(sendSeconds(ROWS[1]!)).toBeNull();
    expect(totals(ROWS).avgSendSec).toBe(35); // (50 + 20) / 2
    expect(totals([]).avgSendSec).toBeNull();
  });

  it('by branch: busiest first, each with its split and failures', () => {
    const b = byBranch(ROWS);
    expect(b.map((x) => x.branch)).toEqual(['LCP-009 Khaleej Plaza', 'LCP-095 One Square RYD']);
    expect(b[1]).toMatchObject({ ticket: 1, custom: 1, failed: 1, total: 2 });
    expect(b[1]!.last).toBe('2026-11-26T11:00:00.000Z');
  });

  it('by sender: custom messages only; the kept name wins, older ones use the account', () => {
    const s = bySender(ROWS, nameOf);
    expect(s).toHaveLength(2);
    expect(s.find((x) => x.key === 'u-nada')).toMatchObject({
      name: 'Nada Al Noaima',
      login: '03032',
      messages: 1,
      branches: 1,
    });
    expect(s.find((x) => x.key === 'u-old')).toMatchObject({ name: 'Ali Old', failed: 1 });
  });

  it('by ticket type: ticket notifications only', () => {
    expect(byTicketType(ROWS)).toEqual([{ type: 'Missing item', count: 2, branches: 2 }]);
  });

  it('search finds branch, sender, employee id, order and text', () => {
    for (const q of ['khaleej', 'nada', '03032', '1234', 'test message']) {
      expect(matches(ROWS[0]!, q, nameOf)).toBe(true);
    }
    expect(matches(ROWS[1]!, 'ali old', nameOf)).toBe(true);
    expect(matches(ROWS[0]!, 'pasta', nameOf)).toBe(false);
  });

  it('times are Riyadh wall-clock', () => {
    expect(riyadhTime('2026-11-26T10:45:49.000Z')).toBe('26/11/2026 13:45');
    expect(riyadhTime(null)).toBe('');
  });
});

/* ── the page ───────────────────────────────────────────────────────────── */

const q = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: q.request } }));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, query: unknown) => ({ collection, query }),
}));
vi.mock('../src/features/store-notifications/api.js', () => ({
  useSenderNames: () => ({ data: new Map([['u-old', 'Ali Old']]) }),
}));

import { BranchNotifyReportPage } from '../src/features/branch-notify-report/BranchNotifyReportPage.js';

function renderPage(path = '/reports/agent-kpi/branch-notifications') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<BranchNotifyReportPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  q.request.mockReset();
  q.request.mockResolvedValue(ROWS);
});

describe('the Branch notifications page', () => {
  it('reads the outbox for the window, newest first', async () => {
    renderPage();
    await screen.findByText('LCP-009 Khaleej Plaza');
    const cmd = q.request.mock.calls[0]![0] as {
      collection: string;
      query: { filter: unknown; sort: string[]; limit: number };
    };
    expect(cmd.collection).toBe('store_notifications');
    expect(JSON.stringify(cmd.query.filter)).toContain('_between');
    expect(cmd.query.sort).toEqual(['-date_created']);
    expect(cmd.query.limit).toBe(-1);
  });

  it('shows the headline numbers', async () => {
    renderPage();
    await screen.findByText('LCP-009 Khaleej Plaza'); // the data has arrived
    expect(screen.getByText('Sent to branches')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).toContain('From tickets / custom');
    expect(text).toMatch(/2\s*\/\s*2/); // tickets / custom
    expect(text).toMatch(/1\s*\/\s*1/); // failed / waiting
  });

  it('By sender names each sender with the employee id', async () => {
    renderPage('/x?view=senders');
    expect(await screen.findByText('Nada Al Noaima')).toBeInTheDocument();
    expect(screen.getByText('03032')).toBeInTheDocument();
    expect(screen.getByText('Ali Old')).toBeInTheDocument();
  });

  it('Every message shows the full trail, with SaraPOS reason on a failure', async () => {
    renderPage('/x?view=all');
    const failed = (await screen.findByText('Please call WeCare.')).closest('tr')!;
    expect(within(failed).getByText('SaraPOS 500: outlet offline')).toBeInTheDocument();
    expect(within(failed).getByText('5 attempts')).toBeInTheDocument();
    expect(within(failed).getByText('Ali Old')).toBeInTheDocument();
    const nada = screen.getByText('Test message.').closest('tr')!;
    expect(within(nada).getByText('Nada Al Noaima (03032)')).toBeInTheDocument();
    expect(within(nada).getByText('#1234')).toBeInTheDocument();
  });

  it('search narrows every view', async () => {
    renderPage('/x?view=all');
    await screen.findByText('Test message.');
    await userEvent.type(
      screen.getByPlaceholderText('Branch, sender, order or text'),
      'nada{Enter}',
    );
    await waitFor(() => expect(screen.queryByText('Fries missing')).toBeNull());
    expect(screen.getByText('Test message.')).toBeInTheDocument();
  });
});
