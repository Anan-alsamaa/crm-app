import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * SEARCHING A LATE-ORDER COUPON BY ITS ORDER NUMBER OR PHONE.
 *
 * Owner-reported, 2026-09-30: "in coupon requests in user portal, the phone
 * number/orderid/code based search is not working properly."
 *
 * A LATE-ORDER COUPON HAS NEITHER A TICKET NOR A CONTACT — that is exactly why
 * `order_id` and `customer_phone` are read onto the row (see the comment on
 * COUPON_REQUEST_FIELDS). The search read only `ticket.order_id` and
 * `contact.phone`, so for those rows every term was compared against `undefined`
 * and matched nothing.
 *
 * Measured against live production: 12 of 32 requests were unfindable by their
 * own order number and 9 by the customer's phone. The order is printed on the
 * row, so typing it and getting an empty list is what was reported. Real codes
 * and orders from that data are used below.
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

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const api = vi.hoisted(() => ({
  useMyCouponRequests: vi.fn(),
  useUpdatePendingCouponRequest: vi.fn(() => ({ mutateAsync: vi.fn() })),
}));
vi.mock('../src/features/coupons/api.js', () => api);

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => auth }));

import { MyCouponsPage } from '../src/features/coupons/MyCouponsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<MyCouponsPage />, { wrapper: Wrapper });
}

/** A late-order coupon: no ticket, no contact, order and phone on the row. */
const lateOrder = (over: Record<string, unknown> = {}) => ({
  id: 'lo1',
  coupon_code: 'OPS-NNFZLHYJ',
  coupon_value: 20,
  coupon_percent: null,
  compensation: 'Compensated',
  reason: null,
  status: 'assigned',
  decided_at: '2026-09-29T10:00:00.000Z',
  decision_note: null,
  date_created: '2026-09-29T09:00:00.000Z',
  title: null,
  ticket: null,
  contact: null,
  order_id: '1325574',
  customer_phone: '0501692001',
  decided_by: null,
  ...over,
});

/** An ordinary ticket-backed coupon, for contrast. */
const ticketBacked = (over: Record<string, unknown> = {}) => ({
  ...lateOrder(),
  id: 'tb1',
  coupon_code: 'SORRY10',
  ticket: { id: 't1', subject: 'Missing item', order_id: '9999111' },
  contact: { id: 'k1', name: 'Saad Al-Harbi', phone: '0555000111' },
  order_id: null,
  customer_phone: null,
  ...over,
});

beforeEach(() => {
  navigate.mockReset();
  api.useMyCouponRequests.mockReturnValue({
    isLoading: false,
    data: [lateOrder(), ticketBacked()],
  });
});

/** The search box, by the label the page gives it. */
const searchBox = () => screen.getByRole('textbox', { name: /search compensation requests/i });

/* Every assertion runs on the "all" tab: these rows are `assigned`, and the page
   opens on pending, which would hide them for reasons unrelated to the search. */
async function showAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^all/i }));
}

describe('coupon search reaches a late-order request', () => {
  it('finds it by the order number carried on the row', async () => {
    const user = userEvent.setup();
    renderPage();
    await showAll(user);
    await user.type(searchBox(), '1325574');
    expect(screen.getByText('OPS-NNFZLHYJ')).toBeInTheDocument();
    // And it is a real filter, not a no-op that shows everything.
    expect(screen.queryByText('SORRY10')).not.toBeInTheDocument();
  });

  it('finds it by the customer phone carried on the row', async () => {
    const user = userEvent.setup();
    renderPage();
    await showAll(user);
    await user.type(searchBox(), '0501692001');
    expect(screen.getByText('OPS-NNFZLHYJ')).toBeInTheDocument();
    expect(screen.queryByText('SORRY10')).not.toBeInTheDocument();
  });

  it('still finds a ticket-backed coupon by its ticket order', async () => {
    const user = userEvent.setup();
    renderPage();
    await showAll(user);
    await user.type(searchBox(), '9999111');
    expect(screen.getByText('SORRY10')).toBeInTheDocument();
    expect(screen.queryByText('OPS-NNFZLHYJ')).not.toBeInTheDocument();
  });

  it('still finds a ticket-backed coupon by the contact phone', async () => {
    const user = userEvent.setup();
    renderPage();
    await showAll(user);
    await user.type(searchBox(), '0555000111');
    expect(screen.getByText('SORRY10')).toBeInTheDocument();
  });

  it('finds either by coupon code', async () => {
    const user = userEvent.setup();
    renderPage();
    await showAll(user);
    await user.type(searchBox(), 'ops-nnfz');
    expect(screen.getByText('OPS-NNFZLHYJ')).toBeInTheDocument();
    expect(screen.queryByText('SORRY10')).not.toBeInTheDocument();
  });

  /* A late-order request carries the customer's number in `title` too, which is
     what an agent reads off the row — so it must be searchable there as well. */
  it('finds it by a phone held in the title', async () => {
    const user = userEvent.setup();
    api.useMyCouponRequests.mockReturnValue({
      isLoading: false,
      data: [
        lateOrder({
          coupon_code: 'OPS-433RHNBB',
          title: '0536418952',
          order_id: null,
          customer_phone: null,
        }),
        ticketBacked(),
      ],
    });
    renderPage();
    await showAll(user);
    await user.type(searchBox(), '0536418952');
    expect(screen.getByText('OPS-433RHNBB')).toBeInTheDocument();
    expect(screen.queryByText('SORRY10')).not.toBeInTheDocument();
  });

  /* A term matching nothing must empty the list rather than fall back to
     everything — the failure mode that hides a broken filter. */
  it('shows nothing for a term that matches nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await showAll(user);
    await user.type(searchBox(), 'zzzzzz-no-such-thing');
    expect(screen.queryByText('OPS-NNFZLHYJ')).not.toBeInTheDocument();
    expect(screen.queryByText('SORRY10')).not.toBeInTheDocument();
  });
});
