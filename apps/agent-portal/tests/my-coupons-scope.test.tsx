import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * MY REQUESTS FIRST (owner, 2026-09-28).
 *
 * The compensation queue has always shown EVERY agent's requests, which is
 * right for a supervisor and wrong for the agent who just raised one — their
 * own ask was buried among everyone else's, across every status. It now opens
 * scoped to the signed-in agent and can be widened to everyone.
 *
 * The COUNTS on the status tabs are scoped with it. A "3 pending" tab above a
 * list holding one row, because the other two belong to a colleague, is a bug
 * report waiting to happen.
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
    i18n: { language: 'en' },
  }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const api = vi.hoisted(() => ({
  useMyCouponRequests: vi.fn(),
  /* The page can correct a pending request; the mock must offer every
     export the module has or the whole module resolves as missing. */
  useUpdatePendingCouponRequest: vi.fn(() => ({ mutateAsync: vi.fn() })),
}));
vi.mock('../src/features/coupons/api.js', () => api);

const auth = vi.hoisted(() => ({ user: { id: 'me' } as { id: string } | null }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => auth }));

import { MyCouponsPage } from '../src/features/coupons/MyCouponsPage.js';

const row = (id: string, by: string | null, status = 'pending') => ({
  id,
  status,
  coupon_code: `CODE-${id}`,
  coupon_value: 10,
  coupon_percent: null,
  discount_category: 'Amount',
  coupon_type: null,
  date_created: '2026-09-28T10:00:00Z',
  decided_at: null,
  decision_note: null,
  ticket: null,
  contact: null,
  requested_by: by ? { id: by, first_name: by, email: null } : null,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<MyCouponsPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  auth.user = { id: 'me' };
  api.useMyCouponRequests.mockReset();
  api.useMyCouponRequests.mockReturnValue({
    data: [row('a', 'me'), row('b', 'colleague'), row('c', 'me', 'approved')],
    isLoading: false,
  });
});

describe('Compensation requests are scoped to me by default', () => {
  it('opens showing only my own pending request', async () => {
    renderPage();
    expect(await screen.findByText('CODE-a')).toBeTruthy();
    expect(screen.queryByText('CODE-b')).toBeNull();
  });

  /* The count must not describe rows the list is not showing. */
  it('counts only my requests on the waiting line', async () => {
    renderPage();
    expect(await screen.findByText(/1 waiting on a supervisor/)).toBeTruthy();
  });

  it('shows everyone when asked, without changing the status tab', async () => {
    renderPage();
    await screen.findByText('CODE-a');
    await userEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(await screen.findByText('CODE-b')).toBeTruthy();
    expect(screen.getByText('CODE-a')).toBeTruthy();
    // Still the pending tab: widening WHO must not also change WHICH.
    expect(screen.queryByText('CODE-c')).toBeNull();
  });

  it('scopes every status, not just the open tab', async () => {
    renderPage();
    await screen.findByText('CODE-a');
    /* The status pills carry `aria-pressed`; the CARDS below are buttons too,
       which is what a bare `getAllByRole('button')` picks up. "all" is the last
       pressable pill. */
    const pills = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed'));
    await userEvent.click(pills[pills.length - 1]!);
    // Mine across both statuses...
    expect(await screen.findByText('CODE-c')).toBeTruthy();
    // ...and still not my colleague's.
    expect(screen.queryByText('CODE-b')).toBeNull();
  });

  /*
   * A signed-out render must not silently hide everything: with no id to
   * compare against there is no "mine", and an empty screen would read as
   * "you have never asked for a coupon".
   */
  it('falls back to showing everything when there is no signed-in user', async () => {
    auth.user = null;
    renderPage();
    expect(await screen.findByText('CODE-a')).toBeTruthy();
    expect(screen.getByText('CODE-b')).toBeTruthy();
  });
});
