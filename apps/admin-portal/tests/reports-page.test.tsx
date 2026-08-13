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
  // jsdom lacks scrollIntoView, which SelectMenu's listbox calls on open.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
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

describe('ReportsPage — the schedule', () => {
  const openDrawer = async () => {
    api.useReports.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    await userEvent.click(screen.getAllByText('New report')[0]!);
  };

  it('offers a monthly-on-the-1st preset instead of asking for cron', async () => {
    await openDrawer();
    await userEvent.click(screen.getByRole('combobox', { name: 'How often' }));
    expect(
      screen.getByRole('option', { name: 'The 1st of every month at 07:00' }),
    ).toBeInTheDocument();
  });

  it('WRITES a cron — the field that makes a schedule fire', async () => {
    // Recipients used to be the only schedule field, so `schedule.cron` was
    // never set and no saved report ever ran on its own: configured-looking,
    // and inert.
    const mutateAsync = vi.fn().mockResolvedValue({});
    api.useCreateReport.mockReturnValue({ mutateAsync, isPending: false });
    await openDrawer();

    await userEvent.type(screen.getByLabelText('Name'), 'Monthly');
    await userEvent.click(screen.getByRole('combobox', { name: 'How often' }));
    // The option is an <li> wrapping the real <button>; clicking the li does
    // nothing, which is exactly the kind of thing a test should hold.
    await userEvent.click(screen.getByRole('button', { name: 'The 1st of every month at 07:00' }));
    await userEvent.type(
      screen.getByPlaceholderText('ops@example.com, manager@example.com'),
      'ops@anan.sa',
    );
    await userEvent.click(screen.getByText('actions.save'));

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: { email: ['ops@anan.sa'], cron: '0 7 1 * *' },
      }),
    );
  });

  it('leaves the cron empty for a manual-only report', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({});
    api.useCreateReport.mockReturnValue({ mutateAsync, isPending: false });
    await openDrawer();

    await userEvent.type(screen.getByLabelText('Name'), 'Ad hoc');
    await userEvent.click(screen.getByText('actions.save'));

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: { email: [], cron: '' } }),
    );
  });

  it('says in words what will happen, because a cron is not a sentence', async () => {
    await openDrawer();
    await userEvent.click(screen.getByRole('combobox', { name: 'How often' }));
    // The option is an <li> wrapping the real <button>; clicking the li does
    // nothing, which is exactly the kind of thing a test should hold.
    await userEvent.click(screen.getByRole('button', { name: 'The 1st of every month at 07:00' }));
    // No recipients yet — and it says so rather than implying delivery.
    expect(screen.getByText(/nobody receives it/)).toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText('ops@example.com, manager@example.com'),
      'ops@anan.sa',
    );
    // The mocked t() does not interpolate, so this asserts the SHAPE of the
    // sentence rather than its filled-in values.
    expect(screen.getByText(/Sent to/)).toBeInTheDocument();
    expect(screen.queryByText(/nobody receives it/)).toBeNull();
  });

  it('reopens an existing schedule on its own preset, not as "custom"', async () => {
    api.useReports.mockReturnValue({
      data: [
        {
          id: 'r1',
          name: 'Volume',
          description: null,
          type: 'conversation_volume',
          filters: null,
          schedule: { email: ['ops@anan.sa'], cron: '0 7 1 * *' },
          last_run_at: null,
        },
      ],
      isLoading: false,
    });
    renderPage();
    await userEvent.click(screen.getByText('edit'));
    expect(screen.getByRole('combobox', { name: 'How often' })).toHaveTextContent(
      'The 1st of every month at 07:00',
    );
  });
});
