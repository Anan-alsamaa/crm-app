import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * THE SUPERVISOR'S OVERRIDE on whether a coupon reaches the Yiji app.
 *
 * The agent chooses this when they raise the request — a customer who wants a
 * refund will not accept an app coupon (owner, 2026-10-01) — and the supervisor
 * deciding it may know better by the time they see it, so it is editable here
 * rather than only displayed.
 *
 * The guard that matters: ONCE THE COUPON HAS BEEN PUSHED, the control is gone.
 * A grant is irreversible from our side — deleting the CRM row does not revoke it
 * on Yiji — so a control that appeared to un-send a delivered coupon would be a
 * lie to the person making the decision.
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
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({
    user: { id: 'sup-1', first_name: 'Nadia' },
    can: () => true,
  }),
}));

const saveMutate = vi.fn();
const api = vi.hoisted(() => ({
  useCouponApprovals: vi.fn(),
  useDecideCoupon: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useSaveCouponTerms: vi.fn(),
  useRetryCouponDelivery: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
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

const row = (over: Record<string, unknown> = {}) => ({
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
  ticket: {
    id: 't1',
    subject: 'Missing item',
    complaint_type: 'Missing item',
    order_id: '1324623',
  },
  contact: { id: 'k1', name: 'Saad Al-Harbi', phone: '+966545808075' },
  requested_by: { id: 'a1', first_name: 'Sara', email: 's@yiji.test' },
  decided_by: null,
  delivery_excluded: false,
  delivery_excluded_reason: null,
  yiji_coupon_user_id: null,
  yiji_push_error: null,
  ...over,
});

/* The card is COLLAPSED until the summary line is clicked, and the summary line
   is named after the ticket. Everything asserted below lives in the detail. */
async function expandFirst(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Missing item/ }));
}

const withholdBox = () =>
  screen.getByRole('checkbox', { name: /do not send this to the customer on the yiji app/i });

beforeEach(() => {
  saveMutate.mockReset();
  api.useSaveCouponTerms.mockReturnValue({ mutate: saveMutate, isPending: false });
  api.useCouponApprovals.mockReturnValue({ isLoading: false, data: [row()] });
});

describe('supervisor override on Yiji delivery', () => {
  it('offers the control, unticked, on a coupon that has not been sent', async () => {
    const user = userEvent.setup();
    renderPage();
    await expandFirst(user);
    expect(withholdBox()).toBeInTheDocument();
    expect(withholdBox()).not.toBeChecked();
  });

  it('withholds the coupon when the supervisor ticks it', async () => {
    const user = userEvent.setup();
    renderPage();
    await expandFirst(user);
    await user.click(withholdBox());
    await waitFor(() => expect(saveMutate).toHaveBeenCalled());
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({
      id: 'ca1',
      edits: { delivery_excluded: true },
    });
  });

  it('shows the state the agent already chose', async () => {
    const user = userEvent.setup();
    api.useCouponApprovals.mockReturnValue({
      isLoading: false,
      data: [
        row({ delivery_excluded: true, delivery_excluded_reason: 'Customer wanted a refund' }),
      ],
    });
    renderPage();
    await expandFirst(user);
    expect(withholdBox()).toBeChecked();
    // And the agent's reason, so the supervisor decides knowing why.
    expect(screen.getByText(/customer wanted a refund/i)).toBeInTheDocument();
  });

  /* A "why it was withheld" left on a coupon that IS being sent reads as a
     contradiction on this very card. */
  it('clears the reason when delivery is switched back on', async () => {
    const user = userEvent.setup();
    api.useCouponApprovals.mockReturnValue({
      isLoading: false,
      data: [
        row({ delivery_excluded: true, delivery_excluded_reason: 'Customer wanted a refund' }),
      ],
    });
    renderPage();
    await expandFirst(user);
    await user.click(withholdBox());
    await waitFor(() => expect(saveMutate).toHaveBeenCalled());
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({
      edits: { delivery_excluded: false, delivery_excluded_reason: null },
    });
  });

  /*
   * THE GUARD. A delivered coupon cannot be un-delivered: the grant lives on
   * Yiji and nothing we do here revokes it. Offering the tickbox would promise
   * something we cannot do.
   */
  it('does NOT offer the control once the coupon reached Yiji', async () => {
    const user = userEvent.setup();
    api.useCouponApprovals.mockReturnValue({
      isLoading: false,
      data: [
        row({
          status: 'approved',
          decided_at: '2026-08-13T12:00:00Z',
          yiji_coupon_user_id: '55123',
        }),
      ],
    });
    renderPage();
    await expandFirst(user);
    expect(
      screen.queryByRole('checkbox', {
        name: /do not send this to the customer on the yiji app/i,
      }),
    ).not.toBeInTheDocument();
  });

  /*
   * A WITHHELD COUPON NEEDS NO ORDER. The "no order number" warning exists
   * because Yiji creates a coupon FROM an order — but nothing is going to Yiji
   * here, so the warning would describe an obstacle to something nobody is
   * attempting, and it wrongly tells the supervisor this cannot be approved.
   */
  it('stops warning about a missing order when the coupon is withheld', async () => {
    const user = userEvent.setup();
    api.useCouponApprovals.mockReturnValue({
      isLoading: false,
      data: [
        row({
          ticket: { id: 't1', subject: 'Missing item', complaint_type: 'Missing item' },
          delivery_excluded: true,
        }),
      ],
    });
    renderPage();
    await expandFirst(user);
    expect(
      screen.queryByText(/cannot be approved until the order is known/i),
    ).not.toBeInTheDocument();
  });

  /* ...but it still warns when the coupon IS meant to be delivered. */
  it('still warns about a missing order on a coupon that will be sent', async () => {
    const user = userEvent.setup();
    api.useCouponApprovals.mockReturnValue({
      isLoading: false,
      data: [
        row({
          ticket: { id: 't1', subject: 'Missing item', complaint_type: 'Missing item' },
          delivery_excluded: false,
        }),
      ],
    });
    renderPage();
    await expandFirst(user);
    expect(screen.getByText(/cannot be approved until the order is known/i)).toBeInTheDocument();
  });
});
