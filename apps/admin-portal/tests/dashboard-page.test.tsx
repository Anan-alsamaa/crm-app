import { describe, it, expect, vi } from 'vitest';
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

// The hero band greets the signed-in admin and links into the reports, so the
// page needs an auth identity and a router.
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { first_name: 'Test', email: 'test@example.com' } }),
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
  it('keeps the name Overview, because that is where people navigate by habit', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('shows the complaints dashboard with no tab to choose first', () => {
    renderPage();
    // The support-activity view is gone: an admin opening the console gets an
    // answer, not a tab decision.
    expect(screen.queryByText('Support activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Complaints')).not.toBeInTheDocument();
    expect(complaintsApi.useComplaintMetrics).toHaveBeenCalled();
  });

  it('carries no range picker of its own to disagree with the complaint filters', () => {
    renderPage();
    expect(screen.queryByRole('combobox', { name: 'Date range' })).not.toBeInTheDocument();
  });
});
