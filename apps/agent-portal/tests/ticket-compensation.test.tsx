import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useState } from 'react';

/**
 * EMA-80 (owner, 2026-10-21): for WeCare Admin / WeCare Supervisor the ticket's
 * Compensation FOLLOWS ITS COUPON.
 *   1. a linked coupon = "Compensated"; "Not Compensated" removes it (reason
 *      required) through the workers;
 *   2. "Assign a coupon" raises a request for THIS ticket, and the ticket is
 *      Compensated once the request exists;
 *   3. "Compensated" with no coupon cannot be chosen.
 * Every other role keeps the old free field.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string; [x: string]: unknown }) => {
      let s = o?.defaultValue ?? k;
      for (const [key, v] of Object.entries(o ?? {})) {
        if (key !== 'defaultValue') s = s.replace(`{{${key}}}`, String(v));
      }
      return s;
    },
  }),
}));

const hooks = vi.hoisted(() => ({
  customerPhone: (t: {
    contact?: { phone: string | null } | null;
    customer_phone?: string | null;
  }) => t.contact?.phone ?? t.customer_phone ?? null,
  customerLabel: (t: { contact?: { name: string | null } | null }) => t.contact?.name ?? null,
  useTickets: vi.fn(),
  useTicket: vi.fn(),
  useTicketEvents: vi.fn(),
  useUpdateTicket: vi.fn(),
  useAddTicketNote: () => ({ mutateAsync: () => Promise.resolve({}), isPending: false }),
  useStampContacted: () => ({ mutate: vi.fn(), mutateAsync: () => Promise.resolve({}) }),
  useAddTicketAttachment: () => ({ mutateAsync: () => Promise.resolve({}) }),
  useRemoveTicketAttachment: () => ({ mutateAsync: () => Promise.resolve({}) }),
  useConversationAttachments: () => ({ data: [], isLoading: false }),
  useCanReadConversation: () => ({ data: true, isLoading: false }),
  useAttachExistingFileToTicket: () => ({
    mutateAsync: () => Promise.resolve({}),
    isPending: false,
  }),
}));
vi.mock('../src/features/tickets/api.js', () => hooks);
vi.mock('../src/features/inbox/api.js', () => ({
  useAgents: () => ({ data: [] }),
  useTeamOptions: () => ({ data: [] }),
}));
const auth = vi.hoisted(() => ({ privileges: {} as Record<string, boolean> }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({
    user: { id: 'sup-1', first_name: 'Noura', last_name: null, email: null },
    can: (k: string) => auth.privileges[k] ?? true,
  }),
}));
const complaints = vi.hoisted(() => ({ useMyComplaints: vi.fn() }));
vi.mock('../src/features/complaints/api.js', () => complaints);
vi.mock('../src/features/tickets/useStoreMatch.js', async () => {
  const { buildStoreIndex, matchStore } = await import('@yiji/shared-types');
  return {
    useStoreIndex: () => ({ index: buildStoreIndex([]), isLoading: false, count: 0 }),
    useOrderStore: (order: { restaurantName?: string | null }) =>
      matchStore(buildStoreIndex([]), order),
    useStores: () => ({
      data: [
        {
          id: 'st-1',
          code: 'LCP-041',
          name: 'Masief Plaza',
          city: 'Riyadh',
          area_manager: null,
          chain_manager: null,
          yiji_restaurant_id: '299',
          brand: { id: 'b1', code: 'LCP', name: 'Casa Pasta', yiji_brand_name: 'La Casa Pasta' },
        },
      ],
      isLoading: false,
    }),
  };
});
vi.mock('../src/features/tickets/option-lists.js', () => ({
  useOptionLists: () => ({ data: [], isLoading: false }),
  optionsFor: () => [],
}));
const coupons = vi.hoisted(() => ({
  rows: [] as unknown[],
  remove: vi.fn(),
  request: vi.fn(),
}));
vi.mock('../src/features/coupons/api.js', () => ({
  useTicketCoupons: (id: string | null) => ({ data: id ? coupons.rows : [], isLoading: false }),
  useRemoveTicketCoupons: () => ({ mutateAsync: coupons.remove, isPending: false }),
  useRequestCouponApproval: () => ({ mutateAsync: coupons.request, isPending: false }),
}));
/* The dialog itself is covered by its own tests; here only WHAT it is given. */
const dialog = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('../src/features/coupons/CouponRequestDialog.js', () => ({
  CouponRequestDialog: (p: Record<string, unknown>) => {
    dialog.props = p;
    return (
      <div role="dialog">
        <button type="button" onClick={() => (p.onCreated as () => void)()}>
          stub-create
        </button>
      </div>
    );
  },
}));

import { TicketsPage } from '../src/features/tickets/TicketsPage.js';
import {
  TicketCompensationField,
  ticketCompensationState,
  wantsCouponRemoval,
} from '../src/features/tickets/TicketCompensation.js';
import type { CouponRequestRow } from '../src/features/coupons/api.js';

const coupon = (over: Partial<CouponRequestRow> = {}): CouponRequestRow =>
  ({
    id: 'ca-1',
    coupon_code: 'OPS-AB12CD34',
    coupon_value: 25,
    coupon_percent: null,
    status: 'assigned',
    removal_status: null,
    ...over,
  }) as CouponRequestRow;

const ticket = {
  id: 't1',
  subject: 'Missing item',
  description: 'The drink was missing',
  status: 'pending',
  priority: 'high',
  assigned_agent: null,
  assigned_team: null,
  conversation: null,
  store: 'st-1',
  contact: { id: 'k1', name: 'Alice', email: null, phone: '0501234567' },
  compensation: 'Compensated',
  complaint_type: 'Missing item',
  order_snapshot: {
    orderId: '1187929',
    status: 'Delivered',
    total: 40,
    currency: 'SAR',
    placedAt: '2026-10-20T10:00:00Z',
    items: [{ name: 'Pepsi', qty: 2, price: 5, sku: '77' }],
    brandName: 'Casa Pasta',
    restaurantName: 'Masief Plaza',
  },
  first_response_due_at: null,
  resolution_due_at: null,
  first_responded_at: null,
  date_created: '2026-10-20T10:00:00.000Z',
};

const row = {
  id: 't1',
  date: '2026-10-20',
  time: '10:00',
  chain: '',
  area: '',
  brand: '',
  city: '',
  restaurantName: '',
  storeMapped: false,
  serviceType: 'Delivery',
  complaintType: 'Missing item',
  customerName: 'Alice',
  customerMobile: '0501234567',
  complaintDescription: '',
  responseDesc: '',
  complaintSource: '',
  orderAmount: null,
  orderNumber: '1187929',
  communicationMethod: '',
  couponCode: '',
  couponValue: null,
  couponPercent: null,
  complaintStatus: 'pending',
  agent: 'Sara',
  compensation: '',
  storeSnapshot: null,
  subject: 'Missing item',
  firstRespondedAt: null,
  firstResponseDueAt: null,
};

let update: ReturnType<typeof vi.fn>;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tickets?id=t1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<TicketsPage />, { wrapper: Wrapper });
}

async function openEdit() {
  renderPage();
  await waitFor(() => expect(screen.getByText('Ticket details')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
}

beforeEach(() => {
  sessionStorage.clear();
  auth.privileges = {};
  coupons.rows = [];
  coupons.remove.mockReset().mockResolvedValue(undefined);
  coupons.request.mockReset().mockResolvedValue({});
  dialog.props = null;
  complaints.useMyComplaints.mockReturnValue({ data: [row], isLoading: false });
  hooks.useTicket.mockReturnValue({ data: ticket, isLoading: false });
  hooks.useTicketEvents.mockReturnValue({ data: [], isLoading: false });
  update = vi.fn().mockResolvedValue({});
  hooks.useUpdateTicket.mockReturnValue({ mutateAsync: update, isPending: false });
});

describe('ticketCompensationState — Compensation follows the coupon', () => {
  it('a linked coupon makes the ticket Compensated, whatever was stored', () => {
    const s = ticketCompensationState([coupon()], 'Not Compensated');
    expect(s.value).toBe('Compensated');
    expect(s.compensatedAllowed).toBe(true);
    expect(s.removable.map((c) => c.id)).toEqual(['ca-1']);
  });

  it('a PENDING request already counts (Compensated once the request exists)', () => {
    expect(ticketCompensationState([coupon({ status: 'pending' })], null).value).toBe(
      'Compensated',
    );
  });

  it('rejected and removed coupons do not count', () => {
    const s = ticketCompensationState(
      [
        coupon({ id: 'a', status: 'rejected' }),
        coupon({ id: 'b', removal_status: 'removed' }),
        coupon({ id: 'c', removal_status: 'not_on_yiji' }),
      ],
      'Compensated',
    );
    expect(s.value).toBe('Not Compensated');
    expect(s.compensatedAllowed).toBe(false);
  });

  it('a USED coupon still counts and is never offered for removal', () => {
    const s = ticketCompensationState([coupon({ removal_status: 'used' })], null);
    expect(s.value).toBe('Compensated');
    expect(s.removable).toEqual([]);
    expect(s.used).toHaveLength(1);
    expect(wantsCouponRemoval(s, 'Not Compensated')).toBe(false);
  });

  it('a failed removal can be tried again', () => {
    const s = ticketCompensationState([coupon({ removal_status: 'failed' })], null);
    expect(s.value).toBe('Compensated');
    expect(wantsCouponRemoval(s, 'Not Compensated')).toBe(true);
  });

  it('a ticket with no coupon rows at all keeps its stored value (legacy)', () => {
    expect(ticketCompensationState([], 'Compensated')).toMatchObject({
      value: 'Compensated',
      compensatedAllowed: true,
    });
    expect(ticketCompensationState([], 'Initial')).toMatchObject({
      value: 'Initial',
      compensatedAllowed: false,
    });
  });
});

function Field({ initial, rows }: { initial: string; rows: CouponRequestRow[] }) {
  const [value, setValue] = useState(initial);
  const [reason, setReason] = useState('');
  const [blocked, setBlocked] = useState(false);
  return (
    <TicketCompensationField
      state={ticketCompensationState(rows, initial)}
      value={value}
      onChange={setValue}
      reason={reason}
      onReasonChange={setReason}
      onAssign={assign}
      blocked={blocked}
      onBlocked={setBlocked}
    />
  );
}
const assign = vi.fn();

describe('TicketCompensationField', () => {
  it('refuses "Compensated" with no coupon and points at Assign a coupon', async () => {
    render(<Field initial="Not Compensated" rows={[]} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Compensated' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Assign a coupon/);
    expect(screen.getByRole('radio', { name: 'Not Compensated' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Assign a coupon' }));
    expect(assign).toHaveBeenCalled();
  });

  it('warns that "Not Compensated" removes the coupon and asks why', async () => {
    render(<Field initial="Compensated" rows={[coupon()]} />);
    expect(screen.queryByLabelText(/Why is the coupon being removed/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Not Compensated' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/OPS-AB12CD34 \(25 SAR\)/);
    expect(screen.getByRole('alert')).toHaveTextContent(/Yiji app/);
    expect(screen.getByLabelText(/Why is the coupon being removed/)).toBeInTheDocument();
  });

  it('says a used coupon cannot be removed, and does not offer it', () => {
    render(<Field initial="Compensated" rows={[coupon({ removal_status: 'used' })]} />);
    expect(screen.getByText(/already used this coupon/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Not Compensated' })).toBeDisabled();
  });
});

describe('ticket details → Edit, for a WeCare Admin / Supervisor', () => {
  it('shows Compensated when a coupon is linked, even if the column said otherwise', async () => {
    coupons.rows = [coupon()];
    hooks.useTicket.mockReturnValue({
      data: { ...ticket, compensation: 'Not Compensated' },
      isLoading: false,
    });
    await openEdit();
    expect(screen.getByRole('radio', { name: 'Compensated' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The free coupon inputs are replaced by the coupon dialog.
    expect(screen.queryByText('Coupon code')).not.toBeInTheDocument();
  });

  it('"Not Compensated" + a reason asks the workers to remove the coupon', async () => {
    coupons.rows = [coupon()];
    await openEdit();
    await userEvent.click(screen.getByRole('radio', { name: 'Not Compensated' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // a reason is required
    await userEvent.type(
      screen.getByLabelText(/Why is the coupon being removed/),
      'Customer took a refund',
    );
    await userEvent.click(save);
    await waitFor(() =>
      expect(coupons.remove).toHaveBeenCalledWith({
        ticketId: 't1',
        couponIds: ['ca-1'],
        reason: 'Customer took a refund',
      }),
    );
    // The ticket keeps its value until the workers have really removed it.
    expect(update.mock.calls[0]![0].patch.compensation).toBe('Compensated');
  });

  it('never saves "Compensated" without a coupon', async () => {
    coupons.rows = [];
    hooks.useTicket.mockReturnValue({
      data: { ...ticket, compensation: 'Not Compensated' },
      isLoading: false,
    });
    await openEdit();
    await userEvent.click(screen.getByRole('radio', { name: 'Compensated' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![0].patch.compensation).toBe('Not Compensated');
    expect(coupons.remove).not.toHaveBeenCalled();
  });

  it('Assign a coupon opens the dialog for THIS ticket, prefilled; Compensated once raised', async () => {
    coupons.rows = [];
    hooks.useTicket.mockReturnValue({
      data: { ...ticket, compensation: 'Not Compensated' },
      isLoading: false,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Ticket details')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Assign a coupon' }));
    expect(dialog.props).toMatchObject({
      open: true,
      ticketId: 't1',
      contactId: 'k1',
      customerPhone: '0501234567',
      brandId: 'La Casa Pasta',
      restaurantId: '299',
      branchName: 'Masief Plaza',
      requestedBy: 'sup-1',
    });
    expect(dialog.props!.orderItems).toEqual([{ name: 'Pepsi', price: 5, qty: 2, sku: '77' }]);
    expect(update).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('dialog')).getByText('stub-create'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ id: 't1', patch: { compensation: 'Compensated' } }),
    );
  });
});

describe('the coupon list says what happened to a removal', () => {
  it('a used coupon reads "Not removed · already used", with the order', async () => {
    coupons.rows = [
      coupon({
        removal_status: 'used',
        removed_reason: 'Customer took a refund',
        removal_detail: 'Already used by the customer on order 1332339 - it cannot be removed.',
      }),
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText('Not removed · already used')).toBeInTheDocument());
    expect(screen.getByText(/order 1332339/)).toBeInTheDocument();
  });

  it('a removed coupon is kept as a record, marked removed, with who did it', async () => {
    coupons.rows = [
      coupon({
        removal_status: 'removed',
        removed_at: '2026-10-21T09:00:00Z',
        removed_by: { id: 'sup-1', first_name: 'Noura', email: null },
        removal_detail: 'Removed from the customer’s Yiji app - verified gone.',
      }),
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText('Removed from the Yiji app')).toBeInTheDocument());
    expect(screen.getByText('OPS-AB12CD34')).toBeInTheDocument();
    expect(screen.getByText('Noura')).toBeInTheDocument();
  });
});

describe('ticket details → Edit, for every other role (unchanged)', () => {
  it('keeps the old Compensation field and coupon inputs, with no Assign button', async () => {
    auth.privileges = { manage_ticket_compensation: false };
    coupons.rows = [coupon()];
    await openEdit();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByText('Coupon code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign a coupon' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(coupons.remove).not.toHaveBeenCalled();
  });
});
