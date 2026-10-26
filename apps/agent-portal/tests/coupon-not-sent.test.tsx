import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/*
 * THE 25 OCT INCIDENT (Shatha, WeCare Agent): a ticket from the Add-ticket
 * form with "Assign a coupon" ticked, for a customer created there and then
 * with "Add as a new customer", a branch picked by hand, no order. The ticket
 * saved; no coupon request reached Directus; the ticket was flipped back to
 * Not Compensated and the error was thrown away.
 *
 * These tests drive that exact form, then (1) send what it built through the
 * REAL sender against a fake Directus, to see whether anything throws in the
 * browser before the request, and (2) pin the new behaviour: Not Compensated
 * until the row exists, a blocking dialog on failure, Retry with the same id.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en' },
  }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-shatha' }, can: () => true }),
}));

/** A Directus that executes the SDK's command thunks, so serialisation is real. */
const fake = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const rows = new Map<string, Record<string, unknown>>();
  const state = { failCreates: 0 };
  const request = async (cmd: () => { method?: string; path: string; body?: string }) => {
    const c = cmd();
    const method = c.method ?? 'GET';
    const body = c.body ? JSON.parse(c.body) : undefined;
    calls.push({ method, path: c.path, body });
    if (method === 'GET' && c.path.startsWith('/items/tickets/')) return { vendor: 'vendor-yiji' };
    if (method === 'GET' && c.path.startsWith('/items/contacts/')) {
      // A contact made seconds ago by "Add as a new customer": vendor is a
      // bare id, no Yiji customer id, no name.
      return {
        id: 'contact-new',
        phone: '0500000000',
        name: null,
        external_customer_id: null,
        vendor: 'vendor-yiji',
      };
    }
    if (method === 'GET' && c.path === '/items/vendors')
      return [{ id: 'vendor-yiji', status: 'active' }];
    // The by-id existence check: one request per test, so every row matches.
    if (method === 'GET' && c.path === '/items/coupon_approvals') return [...rows.values()];
    if (method === 'POST' && c.path === '/items/coupon_approvals') {
      if (state.failCreates > 0) {
        state.failCreates -= 1;
        throw new TypeError('Failed to fetch');
      }
      const row = body as Record<string, unknown>;
      rows.set(String(row.id), row);
      return row;
    }
    if (method === 'POST' && c.path === '/items/ticket_events') return body;
    return method === 'GET' ? [] : {};
  };
  return { calls, rows, state, request };
});
vi.mock('../src/lib/directus.js', () => ({
  directus: { request: fake.request },
  isForbidden: () => false,
  assetUrl: (id: string) => id,
  DIRECTUS_URL: 'http://directus.test',
}));

const hooks = vi.hoisted(() => ({
  useCreateTicketFromConversation: vi.fn(),
  useConversationAttachmentIds: vi.fn(() => ({ data: [] })),
  useStoreNotifyTypes: vi.fn(() => ({ data: [] })),
  useUpdateTicket: vi.fn(),
}));
vi.mock('../src/features/tickets/api.js', () => hooks);

const coupons = vi.hoisted(() => ({
  useRequestCouponApproval: vi.fn(),
  useCouponCodeTaken: vi.fn(() => ({ data: false })),
}));
vi.mock('../src/features/coupons/api.js', () => coupons);

/* No order, so nothing is inferred: the branch is the agent's pick (manual). */
const store = vi.hoisted(() => ({
  id: 's1',
  code: 'LCP-001',
  name: 'Test Branch',
  city: 'Riyadh',
  areaManager: 'AM',
  chainManager: 'CM',
  brandName: 'Casa Pasta',
  brandYijiName: null,
  yijiRestaurantId: '9',
}));
vi.mock('../src/features/tickets/useStoreMatch.js', () => ({
  useStores: () => ({ data: [store], isLoading: false }),
  useStoreIndex: () => ({ index: {}, isLoading: false, count: 1 }),
  toStoreRecord: (s: unknown) => s,
  useOrderStore: () => ({
    store: null,
    via: 'none',
    restaurantName: '',
    brandName: '',
    city: '',
    areaManager: '',
    chainManager: '',
  }),
}));

import { CreateTicketDialog } from '../src/features/tickets/CreateTicketDialog.js';
import { CouponRequestError } from '../src/features/coupons/coupon-request-send.js';

const DRAFT_KEY = 'yiji.agent.ticketDraft.agent-shatha.standalone';

/** The coupon as CouponRequestDialog hands it back (zod-parsed, plain JSON). */
const collectedCoupon = {
  title: '0500000000',
  code: 'WC7K9QXR',
  issuing_side: 'WeCare',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  valid_from: '2026-10-25',
  valid_to: '2026-11-24',
  coupon_value: 25,
  coupon_percent: null,
  max_discount: 25,
  usage_limit: 1,
  compensation_reason: 'Wrong item delivered',
  brand_id: 'Casa Pasta',
  restaurant_id: '9',
  item_name: null,
  item_sku: null,
  no_other_discounts: false,
  delivery_excluded: false,
  delivery_excluded_reason: '',
};

/** The form as Shatha left it: branch picked by hand, coupon created. */
function seedDraft() {
  sessionStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      form: {
        description: '',
        priority: 'medium',
        complaint: {},
        typedOrderId: '',
        lookupId: '',
        storeId: 's1',
        assignCoupon: true,
        collectedCoupon,
        includeOrder: true,
        includeFiles: true,
      },
    }),
  );
}

let createTicket: ReturnType<typeof vi.fn>;
let updateTicket: ReturnType<typeof vi.fn>;
let requestCoupon: ReturnType<typeof vi.fn>;

function renderForm(onCreated = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(
    <CreateTicketDialog
      contactId="contact-new"
      vendorId="vendor-yiji"
      conversationId={null}
      onClose={onClose}
      onCreated={onCreated}
    />,
    { wrapper: Wrapper },
  );
  return { onCreated, onClose };
}

async function chooseComplaintType(label: string) {
  const field = screen.getByText('Ticket type').parentElement!.querySelector('input')!;
  await userEvent.click(field);
  await userEvent.type(field, label);
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

async function save() {
  await chooseComplaintType('Missing item');
  const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  await userEvent.click(submit);
}

const networkError = () =>
  new CouponRequestError({
    kind: 'network',
    status: null,
    detail: 'Failed to fetch',
    attempts: 3,
    requestId: 'x',
  });

beforeEach(() => {
  sessionStorage.clear();
  fake.calls.length = 0;
  fake.rows.clear();
  fake.state.failCreates = 0;
  createTicket = vi.fn().mockResolvedValue({ id: 'tk-new', storeNotify: 'skip' });
  updateTicket = vi.fn().mockResolvedValue({});
  requestCoupon = vi.fn().mockResolvedValue({ id: 'ca1' });
  hooks.useCreateTicketFromConversation.mockReturnValue({ mutateAsync: createTicket });
  hooks.useUpdateTicket.mockReturnValue({ mutateAsync: updateTicket });
  coupons.useRequestCouponApproval.mockReturnValue({ mutateAsync: requestCoupon });
  seedDraft();
});

describe('the 25 Oct scenario: new customer, manual branch, no order, assign coupon', () => {
  it('builds a request the REAL sender serialises and POSTs - nothing throws in the browser first', async () => {
    renderForm();
    await save();
    await waitFor(() => expect(requestCoupon).toHaveBeenCalledTimes(1));
    const input = requestCoupon.mock.calls[0]![0];
    expect(input).toMatchObject({
      ticket: 'tk-new',
      contact: 'contact-new',
      requested_by: 'agent-shatha',
      coupon_code: 'WC7K9QXR',
      coupon_value: 25,
      reason: 'Wrong item delivered',
    });
    // The branch really was the manual pick, and there was no order.
    const ticket = createTicket.mock.calls[0]![0].ticket;
    expect(ticket.order_id).toBeNull();
    expect(ticket.order_snapshot).toBeNull();
    expect(ticket.store).toBe('s1');
    expect(ticket.store_snapshot?.via).toBe('manual');

    const actual = await vi.importActual<typeof import('../src/features/coupons/api.js')>(
      '../src/features/coupons/api.js',
    );
    await actual.sendCouponRequest(input, { sleep: async () => undefined });
    const post = fake.calls.find(
      (c) => c.method === 'POST' && c.path === '/items/coupon_approvals',
    );
    expect(post).toBeTruthy();
    expect((post!.body as { id: string }).id).toBe(input.id);
    expect((post!.body as { vendor: string }).vendor).toBe('vendor-yiji');
  });

  it('a request that never reaches the server is retried with the SAME id, and only one row exists', async () => {
    renderForm();
    await save();
    await waitFor(() => expect(requestCoupon).toHaveBeenCalled());
    const input = requestCoupon.mock.calls[0]![0];
    const actual = await vi.importActual<typeof import('../src/features/coupons/api.js')>(
      '../src/features/coupons/api.js',
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.state.failCreates = 1; // the 25 Oct shape: the POST never lands
    await actual.sendCouponRequest(input, { sleep: async () => undefined });
    const posts = fake.calls.filter(
      (c) => c.method === 'POST' && c.path === '/items/coupon_approvals',
    );
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => (p.body as { id: string }).id)).size).toBe(1);
    expect(fake.rows.size).toBe(1);
  });
});

describe('Compensated only once the coupon exists', () => {
  it('creates the ticket Not Compensated, then marks it Compensated after the request', async () => {
    const { onCreated } = renderForm();
    await save();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tk-new'));
    expect(createTicket.mock.calls[0]![0].ticket.compensation).toBe('Not Compensated');
    expect(updateTicket).toHaveBeenCalledWith({
      id: 'tk-new',
      patch: { compensation: 'Compensated' },
    });
    // The request was made before the flag moved.
    expect(requestCoupon.mock.invocationCallOrder[0]!).toBeLessThan(
      updateTicket.mock.invocationCallOrder[0]!,
    );
  });

  it('leaves a ticket WITHOUT a coupon exactly as before', async () => {
    sessionStorage.clear();
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        v: 1,
        savedAt: new Date().toISOString(),
        form: {
          description: '',
          priority: 'medium',
          complaint: {},
          typedOrderId: '',
          lookupId: '',
          storeId: 's1',
          assignCoupon: false,
          collectedCoupon: null,
          includeOrder: true,
          includeFiles: true,
        },
      }),
    );
    const { onCreated } = renderForm();
    await save();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tk-new'));
    expect(createTicket.mock.calls[0]![0].ticket.compensation).toBe('Not Compensated');
    expect(requestCoupon).not.toHaveBeenCalled();
    expect(updateTicket).not.toHaveBeenCalled();
    expect(screen.queryByText('The coupon was not sent')).not.toBeInTheDocument();
  });
});

describe('the coupon was not sent: a blocking dialog', () => {
  it('stops on the dialog, with the reason, and the ticket stays Not Compensated', async () => {
    requestCoupon.mockRejectedValueOnce(networkError());
    const { onCreated, onClose } = renderForm();
    await save();
    expect(await screen.findByText('The coupon was not sent')).toBeInTheDocument();
    expect(screen.getByText('No connection to the server.')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(updateTicket).not.toHaveBeenCalled();
    // Persistent: Escape does not take the agent away from the question.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('The coupon was not sent')).toBeInTheDocument();
  });

  it('Retry re-sends the SAME request and, on success, marks the ticket Compensated', async () => {
    requestCoupon.mockRejectedValueOnce(networkError());
    const { onCreated } = renderForm();
    await save();
    await screen.findByText('The coupon was not sent');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tk-new'));
    expect(requestCoupon).toHaveBeenCalledTimes(2);
    expect(requestCoupon.mock.calls[1]![0].id).toBe(requestCoupon.mock.calls[0]![0].id);
    expect(updateTicket).toHaveBeenCalledWith({
      id: 'tk-new',
      patch: { compensation: 'Compensated' },
    });
    expect(screen.queryByText('The coupon was not sent')).not.toBeInTheDocument();
  });

  it('a failed Retry keeps the dialog up with the new reason', async () => {
    requestCoupon.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(
      new CouponRequestError({
        kind: 'permission',
        status: 403,
        detail: null,
        attempts: 1,
        requestId: 'x',
      }),
    );
    const { onCreated } = renderForm();
    await save();
    await screen.findByText('The coupon was not sent');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('Your account is not allowed to request coupons.'),
    ).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("Don't add a coupon goes on with the ticket Not Compensated", async () => {
    requestCoupon.mockRejectedValueOnce(networkError());
    const { onCreated } = renderForm();
    await save();
    await screen.findByText('The coupon was not sent');
    await userEvent.click(screen.getByRole('button', { name: "Don't add a coupon" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tk-new'));
    expect(requestCoupon).toHaveBeenCalledTimes(1);
    expect(updateTicket).not.toHaveBeenCalled();
  });
});
