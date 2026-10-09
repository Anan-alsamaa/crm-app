import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

/*
 * MV-7: Agent performance can be narrowed to one vendor — chats, tickets,
 * coupons and every KPI built from them — but only while 2+ vendors are
 * active. With one vendor the control is absent and every read is asked with
 * exactly the filters it had before (no `vendor` key at all).
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('../src/features/inbox/api.js', () => ({
  useAgents: () => ({ data: [{ id: 'faisal', first_name: 'Faisal', email: null }] }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'faisal', first_name: 'Faisal' } }),
}));
const perf = vi.hoisted(() => ({
  useChatTimings: vi.fn(() => ({ data: [], isLoading: false })),
  useCsatByConversation: vi.fn(() => ({ data: new Map<string, number>() })),
  useTicketPerformance: vi.fn(() => ({ data: [], isLoading: false, error: null })),
  useCouponPerformance: vi.fn(() => ({ data: [], isLoading: false, error: null })),
}));
vi.mock('../src/features/performance/api.js', () => perf);
vi.mock('../src/lib/sla-hours.js', () => ({
  useSlaHours: () => ({ data: { chat: null, ticket: null }, isLoading: false }),
}));

const dir = vi.hoisted(() => ({
  value: {
    show: false,
    options: [] as Array<{ id: string; name: string; platformId: string | null }>,
    nameOf: () => null,
  },
}));
vi.mock('../src/lib/vendors.js', () => ({ useVendorDirectory: () => dir.value }));

import { AgentPerformancePage } from '../src/features/performance/AgentPerformancePage.js';

function renderPage(path = '/performance') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<AgentPerformancePage />, { wrapper: Wrapper });
}

const TWO = [
  { id: 'v-yiji', name: 'Yiji', platformId: '1' },
  { id: 'v-two', name: 'Second', platformId: 'test-1' },
];

const lastArg = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.at(-1)?.[0];

beforeEach(() => {
  sessionStorage.clear();
  perf.useChatTimings.mockClear();
  perf.useTicketPerformance.mockClear();
  perf.useCouponPerformance.mockClear();
  dir.value = { show: false, options: [TWO[0]!], nameOf: () => null };
});

describe('Agent performance — vendor filter', () => {
  it('is absent with one vendor, and the reads carry no vendor', () => {
    // Even a choice remembered from when a second vendor was live.
    sessionStorage.setItem(
      'agent-performance:faisal',
      JSON.stringify({ filters: { agentId: 'faisal', vendor: 'v-two' } }),
    );
    renderPage();
    expect(screen.queryByRole('combobox', { name: 'Vendor' })).toBeNull();
    expect(lastArg(perf.useChatTimings)).toEqual({ agentId: 'faisal' });
  });

  it('appears with two vendors; choosing one scopes chats, tickets and coupons', async () => {
    dir.value = { show: true, options: TWO, nameOf: () => null };
    const user = userEvent.setup();
    const view = renderPage();
    expect(lastArg(perf.useChatTimings)).toEqual({ agentId: 'faisal' });

    await user.click(screen.getByRole('combobox', { name: 'Vendor' }));
    await user.click(screen.getByRole('button', { name: 'Second' }));
    expect(lastArg(perf.useChatTimings)).toEqual({ agentId: 'faisal', vendor: 'v-two' });
    expect(lastArg(perf.useCsatByConversation)).toEqual({ agentId: 'faisal', vendor: 'v-two' });

    await user.click(screen.getByRole('tab', { name: 'Tickets' }));
    expect(lastArg(perf.useTicketPerformance)).toEqual({ agentId: 'faisal', vendor: 'v-two' });
    await user.click(screen.getByRole('tab', { name: 'Coupons' }));
    expect(lastArg(perf.useCouponPerformance)).toEqual({ agentId: 'faisal', vendor: 'v-two' });
    view.unmount();
  });
});
