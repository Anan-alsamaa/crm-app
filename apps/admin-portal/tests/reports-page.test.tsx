import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const api = vi.hoisted(() => ({
  useReports: vi.fn(),
  useCreateReport: vi.fn(),
  useUpdateReport: vi.fn(),
  useDeleteReport: vi.fn(),
}));
vi.mock('../src/features/reports/api.js', () => api);

import { ReportsPage } from '../src/features/reports/ReportsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ReportsPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  api.useCreateReport.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  api.useUpdateReport.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  api.useDeleteReport.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('ReportsPage', () => {
  it('shows empty state when no reports', () => {
    api.useReports.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('No saved reports yet.')).toBeInTheDocument();
  });

  it('renders a report card with never-run state', () => {
    api.useReports.mockReturnValue({
      data: [
        {
          id: 'r1',
          name: 'Volume',
          description: 'monthly',
          type: 'conversation_volume',
          filters: null,
          schedule: null,
          last_run_at: null,
        },
      ],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('Volume')).toBeInTheDocument();
    expect(screen.getByText('Never run')).toBeInTheDocument();
  });

  it('opens the create drawer', async () => {
    api.useReports.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    await userEvent.click(screen.getAllByText('New report')[0]!);
    expect(screen.getByText('Recipients')).toBeInTheDocument();
  });
});
