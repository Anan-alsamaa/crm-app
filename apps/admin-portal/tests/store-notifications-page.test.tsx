import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const api = vi.hoisted(() => ({
  useStoreNotifyRules: vi.fn(),
  useSetStoreNotifyRule: vi.fn(),
  useStoreNotifications: vi.fn(),
}));
vi.mock('../src/features/store-notifications/api.js', () => api);

import { StoreNotificationsPage } from '../src/features/store-notifications/StoreNotificationsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<StoreNotificationsPage />, { wrapper: Wrapper });
}

const mutate = vi.fn();

beforeEach(() => {
  mutate.mockReset();
  api.useStoreNotifyRules.mockReturnValue({
    data: [
      { id: 'r1', complaint_type: 'Missing item', enabled: true },
      // Considered and turned OFF — kept as a row, and must read as off.
      { id: 'r2', complaint_type: 'Technical issue', enabled: false },
    ],
    isLoading: false,
  });
  api.useSetStoreNotifyRule.mockReturnValue({ mutate, isPending: false });
  api.useStoreNotifications.mockReturnValue({ data: [], isLoading: false });
});

describe('StoreNotificationsPage', () => {
  it('shows every complaint type, with only the chosen ones on', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Missing item' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Technical issue' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // A type nobody has ruled on is off, not missing.
    expect(screen.getByRole('button', { name: 'Order cold' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('reuses a type’s existing row instead of stacking a second one', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Technical issue' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        complaintType: 'Technical issue',
        enabled: true,
        existingId: 'r2',
      }),
      expect.anything(),
    );
  });

  it('creates a row the first time a type is chosen', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Order cold' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        complaintType: 'Order cold',
        enabled: true,
        existingId: undefined,
      }),
      expect.anything(),
    );
  });

  it('says out loud when nothing is configured', () => {
    api.useStoreNotifyRules.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    // "Nothing selected" is silently identical to "feature broken" unless the
    // page says which one it is.
    expect(screen.getByText(/no branch is told about anything/i)).toBeInTheDocument();
    expect(screen.getByText('0 of 14 selected')).toBeInTheDocument();
  });

  it('shows the queue carrying only the description and the resolution notes', () => {
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'n1',
          complaint_type: 'Missing item',
          description: 'Two burgers missing.',
          resolution_notes: null,
          status: 'queued',
          sent_at: null,
          date_created: '2026-08-13T10:00:00.000Z',
          ticket: { id: 't1', subject: 'Missing item' },
          store: { id: 's1', code: 'LCP-002', name: 'Marina Mall 2' },
        },
      ],
    });
    renderPage();
    const row = screen.getByRole('row', { name: /LCP-002/ });
    expect(within(row).getByText(/Two burgers missing/)).toBeInTheDocument();
    // Absence is stated, not blank — a blank cell reads as a rendering bug.
    expect(within(row).getByText('not written')).toBeInTheDocument();
    expect(within(row).getByText('queued')).toBeInTheDocument();
  });

  it('does not let a queued row read as delivered', async () => {
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'n1',
          complaint_type: 'Missing item',
          description: 'x',
          resolution_notes: 'y',
          status: 'queued',
          sent_at: null,
          date_created: null,
          ticket: null,
          store: { id: 's1', code: 'LCP-002', name: 'Marina Mall 2' },
        },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Delivery to the stores is not connected yet/)).toBeInTheDocument(),
    );
  });
});
