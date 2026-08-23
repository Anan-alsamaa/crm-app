import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

// The Overview is now the complaints dashboard and nothing else; its data layer
// is covered by complaint-dashboard-*.test.tsx, so it is stubbed here.
const complaintsApi = vi.hoisted(() => ({
  useComplaintMetrics: vi.fn(() => ({ isLoading: true, isError: false, data: undefined })),
  useComplaintYears: vi.fn(() => ({ data: [2026], isLoading: false })),
  yearBounds: (y: number) => ({ from: `${y}-01-01`, to: `${y}-12-31` }),
  selectedYear: () => null,
  emptyComplaintFilters: { from: '', to: '', brand: '', city: '', store: '' },
}));
vi.mock('../src/features/dashboard/complaints-api.js', () => complaintsApi);

/**
 * The hero band greets the signed-in admin and links into the reports, so the
 * page needs an auth identity and a router.
 *
 * It also asks whether this role may see the AGENT dashboard: that is what
 * decides whether there are two tabs or one. `chatPrivilege` is a variable so
 * the tests below can answer both ways.
 */
const chatPrivilege = vi.hoisted(() => ({ granted: true }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({
    user: { first_name: 'Test', email: 'test@example.com' },
    can: (priv: string) => (priv === 'view_all_chats' ? chatPrivilege.granted : true),
  }),
}));

import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../src/features/dashboard/DashboardPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<DashboardPage />, { wrapper: Wrapper });
}

describe('DashboardPage', () => {
  beforeEach(() => {
    chatPrivilege.granted = true;
  });

  it('is called Dashboard, and opens on Operations', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    // Operations first: it is the branch view, and the branch question is what
    // this console is opened for.
    expect(complaintsApi.useComplaintMetrics).toHaveBeenCalled();
  });

  it('offers both dashboards to a role that can see chats', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Operations' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agent' })).toBeInTheDocument();
  });

  it('shows one dashboard, and no strip, to a role that cannot see chats', () => {
    // An Operations role holds view_dashboard and not view_all_chats. It lands
    // on the operations dashboard and is not shown a tab it cannot open — a
    // strip of one is a label, not a choice.
    chatPrivilege.granted = false;
    renderPage();
    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Operations' })).not.toBeInTheDocument();
    expect(complaintsApi.useComplaintMetrics).toHaveBeenCalled();
  });

  it('carries no range picker of its own to disagree with the complaint filters', () => {
    renderPage();
    expect(screen.queryByRole('combobox', { name: 'Date range' })).not.toBeInTheDocument();
  });
});
