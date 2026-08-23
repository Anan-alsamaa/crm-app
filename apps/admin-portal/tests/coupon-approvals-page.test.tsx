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
/**
 * A supervisor: signed in, and holding the coupon privilege.
 *
 * Deciding a coupon is a money decision and has its own privilege now, so the
 * page asks before it offers Approve / Edit / Reject. `couponPrivilege` is a
 * variable so one test below can take it away and assert the row goes quiet.
 */
const couponPrivilege = vi.hoisted(() => ({ granted: true }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({
    user: { id: 'sup-1', first_name: 'Nadia' },
    can: (priv: string) => (priv === 'approve_coupons' ? couponPrivilege.granted : true),
  }),
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
  couponPrivilege.granted = true;
  mutate.mockReset();
  api.useCouponApprovals.mockReturnValue({ data: [pending], isLoading: false });
  api.useDecideCoupon.mockReturnValue({ mutate, isPending: false });
});

/**
 * Open a request's detail.
 *
 * Requests render COLLAPSED — a queue of twenty full-height cards was a page
 * nobody could compare across — so anything below the summary line has to be
 * asked for. The summary itself is the toggle.
 */
async function expandFirst(user: ReturnType<typeof userEvent.setup>) {
  // The summary line IS the toggle, and it is named after the ticket.
  await user.click(screen.getByRole('button', { name: /Missing item/ }));
}

describe('CouponApprovalsPage', () => {
  it('opens on what is still waiting, not on settled history', () => {
    renderPage();
    // The supervisor's live question is "what am I holding up".
    expect(api.useCouponApprovals).toHaveBeenCalledWith('pending');
    expect(screen.getByRole('button', { name: 'pending' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('summarises every request in one line, before anything is opened', () => {
    renderPage();
    // What a supervisor triages on: what it is, what it costs, where it went,
    // who asked and when.
    expect(screen.getByText('Missing item')).toBeInTheDocument();
    expect(screen.getByText(/25/)).toBeInTheDocument();
    // Two: the status pill on the row, and the filter tab above it.
    expect(screen.getAllByText('pending').length).toBeGreaterThan(0);
    // The full terms stay behind the click.
    expect(screen.queryByText('SORRY10')).toBeNull();
  });

  it('shows everything needed to decide once the row is opened', async () => {
    const user = userEvent.setup();
    renderPage();
    await expandFirst(user);
    expect(screen.getByText('SORRY10')).toBeInTheDocument();
    expect(screen.getByText(/25/)).toBeInTheDocument();
    // Twice now: the requester on the summary line, and again in the detail.
    expect(screen.getAllByText('Sara').length).toBeGreaterThan(0);
    // Name AND phone now, so a supervisor can read the number back on a call
    // without opening the ticket.
    expect(screen.getByText(/Saad Al-Harbi/)).toBeInTheDocument();
    expect(screen.getByText(/\+9665/)).toBeInTheDocument();
    // The agent's own words. Deciding without them is guessing.
    expect(screen.getAllByText(/Two items missing/).length).toBeGreaterThan(0);
  });

  it('offers no decision to a role without the coupon privilege', () => {
    // Approving is the last gate before a customer is promised money, so it is
    // its own privilege rather than something everyone who can SEE the queue
    // inherits. The route already requires it; this is the second lock, so a
    // change that surfaces the queue read-only somewhere cannot quietly hand
    // out the buttons with it.
    couponPrivilege.granted = false;
    renderPage();

    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Reject')).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
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

  it('says out loud that approving issues the coupon', async () => {
    const user = userEvent.setup();
    renderPage();
    await expandFirst(user);
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

  it('offers no decision on a request already settled', async () => {
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
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    // ...and shows who decided and why, so it stays answerable.
    await expandFirst(user);
    expect(
      screen.getByText(/Decided by Nadia: Value exceeds the order total./),
    ).toBeInTheDocument();
  });

  it('will not save amended terms without a reason for the change', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // Changing what an agent asked for silently leaves them with a different
    // number and no explanation, and leaves an auditor with a changed record
    // and no account of the change.
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await user.type(
      screen.getByLabelText(/reason for the change/i),
      'Above the limit for one item.',
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('closes the editor once the terms are saved, so Save cannot be pressed twice', async () => {
    const saveMutate = vi.fn((_input, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    api.useSaveCouponTerms.mockReturnValue({ mutate: saveMutate, isPending: false });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText(/reason for the change/i), 'Reduced to the standard.');

    // Change something, or there is nothing to save.
    const amount = screen.getByLabelText(/coupon value/i);
    await user.clear(amount);
    await user.type(amount, '10');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveMutate).toHaveBeenCalled();
    // The reason rides WITH the change, in one write.
    expect(saveMutate.mock.calls[0]![0].edits.decision_note).toBe('Reduced to the standard.');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
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
