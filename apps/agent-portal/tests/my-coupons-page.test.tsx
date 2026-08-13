import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    i18n: { language: 'en' },
  }),
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const api = vi.hoisted(() => ({ useMyCouponRequests: vi.fn() }));
vi.mock('../src/features/coupons/api.js', () => api);

import { MyCouponsPage } from '../src/features/coupons/MyCouponsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<MyCouponsPage />, { wrapper: Wrapper });
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  coupon_code: 'SORRY10',
  coupon_value: 25,
  coupon_percent: null,
  compensation: 'Compensated',
  reason: null,
  status: 'pending',
  decided_at: null,
  decision_note: null,
  date_created: '2026-08-13T10:00:00.000Z',
  ticket: { id: 't1', subject: 'Missing item' },
  contact: { id: 'k1', name: 'Saad Al-Harbi', phone: null },
  decided_by: null,
  ...over,
});

beforeEach(() => {
  navigate.mockReset();
  api.useMyCouponRequests.mockReturnValue({
    isLoading: false,
    data: [
      row(),
      row({ id: 'r2', status: 'approved', coupon_code: 'OK5', decided_at: '2026-08-13T12:00:00Z' }),
      row({
        id: 'r3',
        status: 'rejected',
        coupon_code: 'BIG100',
        coupon_value: 100,
        decision_note: 'More than the order was worth.',
        decided_at: '2026-08-13T12:30:00Z',
      }),
    ],
  });
});

describe('MyCouponsPage', () => {
  it('opens on what the agent is still waiting for', () => {
    renderPage();
    // Not on months of settled history — the live question is "what is stuck".
    expect(screen.getByRole('button', { name: /^pending/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('SORRY10')).toBeInTheDocument();
    expect(screen.queryByText('OK5')).toBeNull();
  });

  it('counts what is waiting on a supervisor', () => {
    renderPage();
    expect(screen.getByText('1 waiting on a supervisor')).toBeInTheDocument();
  });

  it('shows a rejection’s reason on the row, not behind a click', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /rejected/ }));
    // This is what the agent has to tell the customer who is still waiting.
    expect(screen.getByText('More than the order was worth.')).toBeInTheDocument();
  });

  it('says so when a rejection came with no reason at all', async () => {
    api.useMyCouponRequests.mockReturnValue({
      isLoading: false,
      data: [row({ status: 'rejected', decision_note: null })],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /rejected/ }));
    expect(screen.getByText('No reason was given.')).toBeInTheDocument();
  });

  it('opens the ticket the coupon was for', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('SORRY10'));
    expect(navigate).toHaveBeenCalledWith('/tickets/t1');
  });

  it('says nothing is waiting rather than showing an empty list', () => {
    api.useMyCouponRequests.mockReturnValue({ isLoading: false, data: [] });
    renderPage();
    expect(screen.getByText('Nothing waiting on a supervisor.')).toBeInTheDocument();
  });
});
