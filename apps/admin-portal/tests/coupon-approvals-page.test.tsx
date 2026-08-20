import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'sup-1', first_name: 'Nadia' } }),
}));

const api = vi.hoisted(() => ({
  useCouponApprovals: vi.fn(),
  useDecideCoupon: vi.fn(),
  useSaveCouponTerms: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
vi.mock('../src/features/coupon-approvals/api.js', () => api);

import { CouponApprovalsPage } from '../src/features/coupon-approvals/CouponApprovalsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<CouponApprovalsPage />, { wrapper: Wrapper });
}

const pending = {
  id: 'ca1',
  coupon_code: 'SORRY10',
  coupon_value: 25,
  coupon_percent: null,
  compensation: 'Compensated',
  reason: 'Two items missing from a 4-item order.',
  status: 'pending' as const,
  decided_at: null,
  decision_note: null,
  date_created: '2026-08-13T10:00:00.000Z',
  ticket: { id: 't1', subject: 'Missing item', complaint_type: 'Missing item' },
  contact: { id: 'k1', name: 'Saad Al-Harbi', phone: '+9665' },
  requested_by: { id: 'a1', first_name: 'Sara', email: 's@yiji.test' },
  decided_by: null,
};

const mutate = vi.fn();

beforeEach(() => {
  mutate.mockReset();
  api.useCouponApprovals.mockReturnValue({ data: [pending], isLoading: false });
  api.useDecideCoupon.mockReturnValue({ mutate, isPending: false });
});

describe('CouponApprovalsPage', () => {
  it('opens on what is still waiting, not on settled history', () => {
    renderPage();
    // The supervisor's live question is "what am I holding up".
    expect(api.useCouponApprovals).toHaveBeenCalledWith('pending');
    expect(screen.getByRole('button', { name: 'pending' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows everything needed to decide without leaving the row', () => {
    renderPage();
    expect(screen.getByText('SORRY10')).toBeInTheDocument();
    expect(screen.getByText(/25/)).toBeInTheDocument();
    expect(screen.getByText('Sara')).toBeInTheDocument();
    // Name AND phone now, so a supervisor can read the number back on a call
    // without opening the ticket.
    expect(screen.getByText(/Saad Al-Harbi/)).toBeInTheDocument();
    expect(screen.getByText(/\+9665/)).toBeInTheDocument();
    // The agent's own words. Deciding without them is guessing.
    expect(screen.getByText(/Two items missing/)).toBeInTheDocument();
  });

  it('approves in a single click', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ approve: true, supervisorId: 'sup-1' }),
      expect.anything(),
    );
  });

  it('says out loud that approving issues the coupon', () => {
    renderPage();
    expect(screen.getByText('Approving puts the coupon on the ticket.')).toBeInTheDocument();
  });

  it('will not reject without a reason', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    // An agent told only "no" cannot answer the customer who is still waiting.
    const confirm = screen.getByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rejects once a reason is given, and carries it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    // Named, not "the textbox": the page has a search field of its own now.
    await user.type(screen.getByPlaceholderText(/why/i), 'Value exceeds the order total.');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ approve: false, note: 'Value exceeds the order total.' }),
      expect.anything(),
    );
  });

  it('offers no decision on a request already settled', () => {
    api.useCouponApprovals.mockReturnValue({
      data: [
        {
          ...pending,
          status: 'rejected',
          decided_at: '2026-08-13T11:00:00.000Z',
          decision_note: 'Value exceeds the order total.',
          decided_by: { id: 'sup-1', first_name: 'Nadia', email: null },
        },
      ],
      isLoading: false,
    });
    renderPage();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    // ...and shows who decided and why, so it stays answerable.
    expect(
      screen.getByText(/Decided by Nadia: Value exceeds the order total./),
    ).toBeInTheDocument();
  });

  it('says the queue is clear rather than showing an empty box', () => {
    api.useCouponApprovals.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('Nothing waiting. The queue is clear.')).toBeInTheDocument();
  });

  it('can look back at what was already decided', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'approved' }));
    await waitFor(() => expect(api.useCouponApprovals).toHaveBeenCalledWith('approved'));
  });
});
