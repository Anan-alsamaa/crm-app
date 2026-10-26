import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = o?.defaultValue ?? k;
      for (const [name, v] of Object.entries(o ?? {})) s = s.replace(`{{${name}}}`, String(v));
      return s;
    },
  }),
}));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: vi.fn(async () => []) } }));

const api = vi.hoisted(() => ({
  useChatsKpi: vi.fn(),
  useTicketsKpi: vi.fn(),
  useCouponsKpi: vi.fn(),
  useLateOrdersKpi: vi.fn(),
  usePeopleKpi: vi.fn(),
  useNotificationsKpi: vi.fn(),
  useAiKpi: vi.fn(),
  useYijiUsageKpi: vi.fn(),
  RECENT_USAGE_LIMIT: 500,
}));
vi.mock('../src/features/admin-kpi/api.js', () => api);

import { AdminKpiPage } from '../src/features/admin-kpi/AdminKpiPage.js';

const ok = <T,>(data: T) => ({
  data,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return render(<AdminKpiPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  api.useChatsKpi.mockReturnValue(
    ok({ total: 7, open: 2, closed: 5, responded: 5, avgFirstResponseSec: 90 }),
  );
  api.useTicketsKpi.mockReturnValue(
    ok({ created: 10, byStatus: { solved: 6 }, compensated: 3, notCompensated: 2, undecided: 5 }),
  );
  api.useCouponsKpi.mockReturnValue(
    ok({
      requested: 15,
      approved: 6,
      rejected: 4,
      pending: 5,
      pushed: 3,
      pushFailures: 1,
      withheld: 2,
      removal: { removed: 1 },
    }),
  );
  api.useLateOrdersKpi.mockReturnValue(
    ok({ decisions: 4, orders: 2, commented: 1, compensated: 1 }),
  );
  api.usePeopleKpi.mockReturnValue(
    ok({ active: 12, suspended: 1, byRole: [{ role: 'Agent', count: 10 }], busyNow: 2 }),
  );
  api.useNotificationsKpi.mockReturnValue(
    ok({ total: 30, unread: 4, byType: [{ type: 'assignment', count: 20 }] }),
  );
  api.useAiKpi.mockReturnValue(
    ok({ calls: 40, errors: 1, costUsd: 0.42, tokens: 9000, avgLatencyMs: 800 }),
  );
  api.useYijiUsageKpi.mockReturnValue(
    ok({
      totals: { total: 100, crm: 96, backup: 4, ok: 94, refused: 4, error: 2, backupPct: 4 },
      rateLimited: 37,
      breakerOpens: 2,
      operations: [
        { operation: 'coupon.remove', total: 4, crm: 2, backup: 2, refused: 2, error: 0 },
      ],
      trend: [
        { day: '2026-10-20', crm: 50, backup: 2, failed: 3 },
        { day: '2026-10-21', crm: 46, backup: 2, failed: 3 },
      ],
      lastBackup: {
        id: 9,
        date_created: '2026-10-21T09:00:00Z',
        service: 'workers',
        operation: 'coupon.remove',
        account: 'backup',
        outcome: 'ok',
        http_status: 200,
        duration_ms: 120,
        fallback_reason: 'crm account refused (403)',
        error: null,
        vendor: '1',
      },
      recent: [
        {
          id: 9,
          date_created: '2026-10-21T09:00:00Z',
          service: 'workers',
          operation: 'coupon.remove',
          account: 'backup',
          outcome: 'ok',
          http_status: 200,
          duration_ms: 120,
          fallback_reason: 'crm account refused (403)',
          error: null,
          vendor: '1',
        },
        {
          id: 8,
          date_created: '2026-10-21T08:59:00Z',
          service: 'workers',
          operation: 'coupon.remove',
          account: 'crm',
          outcome: 'refused',
          http_status: 403,
          duration_ms: 80,
          fallback_reason: null,
          error: 'HTTP 403',
          vendor: '1',
        },
      ],
    }),
  );
});

describe('AdminKpiPage', () => {
  it('shows every feature block and the Yiji usage by account', () => {
    renderPage();
    for (const title of [
      'Chats',
      'Tickets',
      'Coupons',
      'Late orders',
      'Users & roles',
      'Notifications',
      'AI calls',
      'Yiji API usage',
    ]) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/Backup last used/)).toBeInTheDocument();
    expect(
      screen.getByText(/crm account refused \(403\)\s*$/, { selector: 'p' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Yiji failures and backup uses' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('HTTP 403').length).toBeGreaterThan(0);
  });

  it('shows Yiji telling us to slow down: 429s and breaker pauses (incident 2026-10-26)', () => {
    renderPage();
    expect(screen.getByText('Rate-limited (429)')).toBeInTheDocument();
    expect(screen.getByText('37')).toBeInTheDocument();
    expect(screen.getByText('Non-urgent calls paused')).toBeInTheDocument();
  });

  it('one failed block does not take the page down', () => {
    api.useAiKpi.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText('This block could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('Yiji API usage')).toBeInTheDocument();
  });

  it('says so when Yiji was never refused and the backup never used', () => {
    api.useYijiUsageKpi.mockReturnValue(
      ok({
        totals: { total: 0, crm: 0, backup: 0, ok: 0, refused: 0, error: 0, backupPct: null },
        operations: [],
        trend: null,
        lastBackup: null,
        recent: [],
      }),
    );
    renderPage();
    expect(screen.getByText('Backup never used')).toBeInTheDocument();
    expect(screen.getByText('No failures and no backup use in this window.')).toBeInTheDocument();
  });
});
