import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import type { YijiOrder } from '@yiji/shared-types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const client = vi.hoisted(() => ({
  getOrders: vi.fn(),
  getOrder: vi.fn(),
  getInboxOrders: vi.fn(),
}));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce: client }));
// The panel records the order it resolved back onto the conversation, which is
// a Directus write. Not the subject of these cases — stub it so it succeeds.
vi.mock('../src/lib/directus.js', () => ({ directus: { request: vi.fn().mockResolvedValue({}) } }));

import { LatestOrder, CustomerOrders } from '../src/features/commerce/OrderViews.js';
import {
  addOrder,
  chooseOrder,
  getAddedOrders,
  getChosenOrder,
  removeOrder,
} from '../src/features/commerce/pinned-order.js';

function renderView(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

/** A list summary (no items — mirrors the Yiji list endpoint). */
function summary(id: string, placedAt: string, over: Partial<YijiOrder> = {}): YijiOrder {
  return {
    orderId: id,
    status: 'delivered',
    total: 26,
    currency: 'SAR',
    placedAt,
    items: [],
    ...over,
  };
}

/** A full order (with items — mirrors the single-order endpoint). */
function full(id: string, over: Partial<YijiOrder> = {}): YijiOrder {
  return {
    orderId: id,
    status: 'delivered',
    total: 26,
    currency: 'SAR',
    placedAt: '2026-06-25T12:25:32',
    items: [{ sku: 's1', name: 'Cheeseburger', qty: 2, price: 10 }],
    restaurantId: '312',
    restaurantName: 'Burger Palace',
    deliveryType: 'delivery',
    deliveryAddress: 'King Fahd Rd, Riyadh',
    paymentStatus: 'paid',
    paymentMode: 'apple_pay',
    ...over,
  };
}

beforeEach(() => {
  client.getOrders.mockReset();
  client.getOrder.mockReset();
  client.getInboxOrders.mockReset();
  // The inbox panel asks for the list and the newest order's full detail in a
  // SINGLE call now. Compose that answer from the two mocks each case already
  // sets, so the cases keep describing what the commerce API returns rather
  // than which endpoint carried it.
  client.getInboxOrders.mockImplementation(
    async (vendorId: string, customerId: string, opts?: { limit?: number }) => {
      const orders = (await client.getOrders(vendorId, customerId, opts)) ?? [];
      const first = orders[0];
      const detail = first ? await client.getOrder(vendorId, first.orderId) : null;
      return { orders, detail };
    },
  );
});

describe('LatestOrder (inbox)', () => {
  it('auto-expands the newest order and loads its full details', async () => {
    client.getOrders.mockResolvedValue([summary('946641', '2026-06-25T12:25:32')]);
    client.getOrder.mockResolvedValue(full('946641'));
    renderView(<LatestOrder vendorId="v1" customerId="cust-guid" />);

    // defaultOpen → detail fetched without a click; all key fields render.
    await waitFor(() => expect(screen.getByText('Burger Palace')).toBeInTheDocument());
    expect(screen.getByText(/Restaurant ID/)).toBeInTheDocument(); // restaurant id
    expect(screen.getByText(/#312/)).toBeInTheDocument();
    expect(screen.getByText('Delivery')).toBeInTheDocument(); // delivery type label
    expect(screen.getByText(/Cheeseburger/)).toBeInTheDocument();
    expect(screen.getByText(/each/)).toBeInTheDocument(); // unit price (qty > 1)
    expect(screen.getByText('Items subtotal')).toBeInTheDocument(); // total > subtotal
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Apple Pay')).toBeInTheDocument();
    expect(screen.getByText(/King Fahd/)).toBeInTheDocument();
    expect(screen.getByText('Latest order')).toBeInTheDocument();
  });

  it('shows the last 2 orders — newest auto-expanded, second collapsed', async () => {
    client.getOrders.mockResolvedValue([
      summary('A-1', '2026-06-25T15:00:00'),
      summary('A-2', '2026-06-20T09:00:00'),
      summary('B-9', '2026-06-09T13:00:00'),
    ]);
    client.getOrder.mockImplementation((_v: string, id: string) => Promise.resolve(full(id)));
    renderView(<LatestOrder vendorId="v1" customerId="cust-guid" />);

    await waitFor(() => expect(screen.getByText('Latest orders')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /A-1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /A-2/ })).toBeInTheDocument();
    // Only the previous 2 orders — the third is not shown.
    expect(screen.queryByRole('button', { name: /B-9/ })).not.toBeInTheDocument();

    // Newest (A-1) is auto-expanded → its detail was fetched; A-2 was not.
    await waitFor(() => expect(client.getOrder).toHaveBeenCalledWith('v1', 'A-1'));
    expect(client.getOrder).not.toHaveBeenCalledWith('v1', 'A-2');
  });

  it('shows a single order (singular heading) when there is only one', async () => {
    client.getOrders.mockResolvedValue([summary('X-1', '2026-06-25T15:00:00')]);
    client.getOrder.mockImplementation((_v: string, id: string) => Promise.resolve(full(id)));
    renderView(<LatestOrder vendorId="v1" customerId="cust-guid" />);

    expect(await screen.findByRole('button', { name: /X-1/ })).toBeInTheDocument();
    expect(screen.getByText('Latest order')).toBeInTheDocument();
  });

  it('shows "no orders" for a customer with an empty history', async () => {
    client.getOrders.mockResolvedValue([]);
    renderView(<LatestOrder vendorId="v1" customerId="cust-guid" />);
    await waitFor(() =>
      expect(
        screen.getByText('No orders found for this contact. Enter an order ID to look it up.'),
      ).toBeInTheDocument(),
    );
  });

  it('shows "unavailable" when the commerce proxy errors', async () => {
    client.getOrders.mockRejectedValue(new Error('commerce 500'));
    renderView(<LatestOrder vendorId="v1" customerId="cust-guid" />);
    await waitFor(() => expect(screen.getByText(/Commerce data unavailable/)).toBeInTheDocument());
  });

  it('renders nothing (and runs no query) without ids', () => {
    const { container } = renderView(<LatestOrder vendorId="" customerId="" />);
    expect(container).toBeEmptyDOMElement();
    expect(client.getOrders).not.toHaveBeenCalled();
  });

  it('leaves the order id as plain text when nothing can be raised from it', async () => {
    client.getOrders.mockResolvedValue([summary('P-1', '2026-06-25T15:00:00')]);
    client.getOrder.mockImplementation((_v: string, id: string) => Promise.resolve(full(id)));
    // No conversation to pin against and no handler → no ticket trigger, and
    // the only button on the row stays the expand/collapse toggle.
    renderView(<LatestOrder vendorId="v1" customerId="cust-guid" />);

    await waitFor(() => expect(screen.getByText('#P-1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /New complaint/ })).not.toBeInTheDocument();
  });

  it('order id is a button that CHOOSES that order and asks for a ticket', async () => {
    sessionStorage.clear();
    // Two orders: the complaint is about the OLDER one, which is exactly the
    // case the automatic "latest order" lookup gets wrong.
    client.getOrders.mockResolvedValue([
      summary('N-1', '2026-06-25T15:00:00'),
      summary('N-2', '2026-06-20T09:00:00'),
    ]);
    client.getOrder.mockImplementation((_v: string, id: string) => Promise.resolve(full(id)));
    const onCreateTicket = vi.fn();
    renderView(
      <LatestOrder
        vendorId="v1"
        customerId="cust-guid"
        conversationId="conv-7"
        onCreateTicket={onCreateTicket}
      />,
    );

    const trigger = await screen.findByRole('button', {
      name: 'New complaint for order #N-2',
    });
    fireEvent.click(trigger);

    expect(onCreateTicket).toHaveBeenCalledTimes(1);
    expect(onCreateTicket.mock.calls[0]![0]).toMatchObject({ orderId: 'N-2' });
    // Pinned under the conversation, which is how CreateTicketDialog picks it up.
    expect(getChosenOrder('conv-7')?.orderId).toBe('N-2');
    // Clicking the id must not also expand the card (it sits above the toggle).
    expect(client.getOrder).not.toHaveBeenCalledWith('v1', 'N-2');
  });
});

describe('CustomerOrders (contact panel)', () => {
  it('lists collapsed rows and fetches details only on expand', async () => {
    client.getOrders.mockResolvedValue([summary('C-1', '2026-06-25T12:00:00')]);
    client.getOrder.mockResolvedValue(full('C-1'));
    renderView(<CustomerOrders vendorId="v1" customerId="cust-guid" limit={5} />);

    const row = await screen.findByRole('button', { name: /C-1/ });
    // Collapsed: no detail fetch, no items visible.
    expect(client.getOrder).not.toHaveBeenCalled();
    expect(screen.queryByText(/Cheeseburger/)).not.toBeInTheDocument();

    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText(/Cheeseburger/)).toBeInTheDocument());
    expect(client.getOrder).toHaveBeenCalledWith('v1', 'C-1');
  });

  it('shows "no line items" when the order has none', async () => {
    client.getOrders.mockResolvedValue([summary('C-2', '2026-06-25T12:00:00')]);
    client.getOrder.mockResolvedValue(full('C-2', { items: [] }));
    renderView(<CustomerOrders vendorId="v1" customerId="cust-guid" />);

    fireEvent.click(await screen.findByRole('button', { name: /C-2/ }));
    await waitFor(() =>
      expect(screen.getByText('No line items on this order.')).toBeInTheDocument(),
    );
  });

  it('shows "details unavailable" when the single order is not found', async () => {
    client.getOrders.mockResolvedValue([summary('C-3', '2026-06-25T12:00:00')]);
    client.getOrder.mockResolvedValue(null);
    renderView(<CustomerOrders vendorId="v1" customerId="cust-guid" />);

    fireEvent.click(await screen.findByRole('button', { name: /C-3/ }));
    await waitFor(() => expect(screen.getByText('Order details unavailable.')).toBeInTheDocument());
  });

  it('shows "no orders" when the list is empty', async () => {
    client.getOrders.mockResolvedValue([]);
    renderView(<CustomerOrders vendorId="v1" customerId="cust-guid" />);
    await waitFor(() => expect(screen.getByText('No orders yet.')).toBeInTheDocument());
  });

  it('shows "unavailable" when the list query errors', async () => {
    client.getOrders.mockRejectedValue(new Error('commerce 401'));
    renderView(<CustomerOrders vendorId="v1" customerId="cust-guid" />);
    await waitFor(() => expect(screen.getByText(/Commerce data unavailable/)).toBeInTheDocument());
  });

  it('renders nothing without ids', () => {
    const { container } = renderView(<CustomerOrders vendorId="v1" customerId="" />);
    expect(container).toBeEmptyDOMElement();
    expect(client.getOrders).not.toHaveBeenCalled();
  });
});

describe('LatestOrder — keeping orders the agent looked up', () => {
  beforeEach(() => sessionStorage.clear());

  const lookup = async (id: string) => {
    fireEvent.change(screen.getByLabelText('Look up an order by ID'), { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  };

  it('offers the manual search even when the customer already has orders', async () => {
    // It used to appear only when the automatic lookup came back empty, which
    // made "the complaint is about an older order" an invisible case.
    client.getOrders.mockResolvedValue([summary('N-1', '2026-07-01T10:00:00')]);
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-1" />);
    await screen.findByText(/N-1/);
    expect(screen.getByLabelText('Look up an order by ID')).toBeInTheDocument();
  });

  it('does not keep a looked-up order until the agent says so', async () => {
    // A lookup is a question, not a decision: auto-keeping made every mistyped
    // number permanent.
    client.getOrders.mockResolvedValue([]);
    client.getOrder.mockResolvedValue(full('N-9'));
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-2" />);
    await lookup('N-9');
    await screen.findByRole('button', { name: '+ Keep this order' });
    expect(getAddedOrders('conv-2')).toHaveLength(0);
  });

  it('keeps it, and clears the search box so it is not shown twice', async () => {
    client.getOrders.mockResolvedValue([]);
    client.getOrder.mockResolvedValue(full('N-9'));
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-3" />);
    await lookup('N-9');
    fireEvent.click(await screen.findByRole('button', { name: '+ Keep this order' }));
    await waitFor(() => expect(getAddedOrders('conv-3').map((o) => o.orderId)).toEqual(['N-9']));
    expect(screen.getByLabelText('Look up an order by ID')).toHaveValue('');
  });

  it('shows a kept order alongside the automatic ones', async () => {
    client.getOrders.mockResolvedValue([summary('N-1', '2026-07-01T10:00:00')]);
    client.getOrder.mockResolvedValue(full('N-9'));
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-4" />);
    await screen.findByText(/N-1/);
    await lookup('N-9');
    fireEvent.click(await screen.findByRole('button', { name: '+ Keep this order' }));
    await waitFor(() => expect(screen.getAllByText(/N-9/).length).toBeGreaterThan(0));
    expect(screen.getByText(/N-1/)).toBeInTheDocument();
  });

  it("offers Remove on a kept order only — never on the customer's own", async () => {
    // A remove control on a fetched order would imply the panel had been
    // edited; those are fact, not a working note.
    client.getOrders.mockResolvedValue([summary('N-1', '2026-07-01T10:00:00')]);
    client.getOrder.mockResolvedValue(full('N-9'));
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-5" />);
    await screen.findByText(/N-1/);
    expect(screen.queryByRole('button', { name: /Remove order/ })).toBeNull();

    await lookup('N-9');
    fireEvent.click(await screen.findByRole('button', { name: '+ Keep this order' }));
    // Exactly one Remove — for the kept order, not the customer's own. (The
    // i18n mock returns the raw defaultValue, so assert on the count and the
    // row it sits in rather than on interpolated label text.)
    const removes = await screen.findAllByRole('button', { name: /Remove order/ });
    expect(removes).toHaveLength(1);
    expect(removes[0]!.closest('li')!.textContent).toContain('N-9');
  });

  it('removes a kept order when asked', async () => {
    client.getOrders.mockResolvedValue([]);
    client.getOrder.mockResolvedValue(full('N-9'));
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-6" />);
    await lookup('N-9');
    fireEvent.click(await screen.findByRole('button', { name: '+ Keep this order' }));
    await waitFor(() => expect(getAddedOrders('conv-6')).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /Remove order/ }));
    await waitFor(() => expect(getAddedOrders('conv-6')).toHaveLength(0));
  });

  it('adding the same order twice keeps one copy', async () => {
    client.getOrders.mockResolvedValue([]);
    client.getOrder.mockResolvedValue(full('N-9'));
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-7b" />);
    for (const _ of [1, 2]) {
      await lookup('N-9');
      fireEvent.click(await screen.findByRole('button', { name: '+ Keep this order' }));
      await waitFor(() => expect(getAddedOrders('conv-7b').length).toBeGreaterThan(0));
    }
    expect(getAddedOrders('conv-7b')).toHaveLength(1);
  });

  it('does not duplicate an order that is both kept and automatic', async () => {
    // If the customer's own list later includes it, show it once — as the
    // automatic one, so it keeps its "cannot be removed" status.
    client.getOrders.mockResolvedValue([summary('N-9', '2026-07-01T10:00:00')]);
    addOrder('conv-8', full('N-9'));
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-8" />);
    await screen.findByText(/N-9/);
    expect(screen.queryByRole('button', { name: /Remove order/ })).toBeNull();
  });

  it('the ticket follows a KEPT order when that is the one clicked', async () => {
    // The case the whole feature exists for: the customer's two recent orders
    // are on screen, the complaint is about an older one the agent looked up,
    // and clicking it must be what the ticket records.
    const onCreate = vi.fn();
    client.getOrders.mockResolvedValue([
      summary('N-1', '2026-07-02T10:00:00'),
      summary('N-2', '2026-07-01T10:00:00'),
    ]);
    client.getOrder.mockImplementation((_v: string, id: string) => Promise.resolve(full(id)));
    addOrder('conv-9', full('OLD-7'));
    renderView(
      <LatestOrder
        vendorId="v1"
        customerId="c1"
        conversationId="conv-9"
        onCreateTicket={onCreate}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New complaint for order #OLD-7' }));
    await waitFor(() => expect(getChosenOrder('conv-9')?.orderId).toBe('OLD-7'));
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ orderId: 'OLD-7' });
  });

  it('removing the chosen order forgets the choice', async () => {
    // Otherwise the ticket would be filed against an order no longer on screen.
    addOrder('conv-10', full('N-9'));
    chooseOrder('conv-10', full('N-9'));
    expect(getChosenOrder('conv-10')?.orderId).toBe('N-9');
    removeOrder('conv-10', 'N-9');
    expect(getChosenOrder('conv-10')).toBeNull();
  });
});

describe('LatestOrder — a contact with no linked commerce customer', () => {
  beforeEach(() => sessionStorage.clear());

  it('does not sit on a loading skeleton forever', async () => {
    // The orders query is disabled without a customer id, so it never
    // resolves: `isLoading` stays true and the panel pretends to be loading an
    // order that will never arrive. This is the common phone-enquiry case.
    renderView(<LatestOrder vendorId="v1" conversationId="conv-nc" />);
    expect(await screen.findByLabelText('Look up an order by ID')).toBeInTheDocument();
    expect(screen.getByText(/No orders found for this contact/)).toBeInTheDocument();
    expect(client.getOrders).not.toHaveBeenCalled();
  });
});

describe('LatestOrder — when the commerce proxy is unreachable', () => {
  beforeEach(() => sessionStorage.clear());

  it('keeps the stamped order on screen instead of replacing it with a denial', async () => {
    /**
     * The stamp exists for exactly this moment, and the panel used to throw it
     * away in it: the error branch was evaluated before the "do we have
     * anything to show" branch, so a failed lookup wiped a correct, fully
     * painted order card and printed "unavailable" over the top of it.
     */
    client.getOrders.mockRejectedValue(new Error('proxy down'));
    renderView(
      <LatestOrder
        vendorId="v1"
        customerId="c1"
        conversationId="conv-stamped"
        stamped={summary('946641', '2026-06-25T12:00:00')}
      />,
    );
    expect(await screen.findByText(/946641/)).toBeInTheDocument();
    expect(screen.queryByText(/Commerce data unavailable/)).not.toBeInTheDocument();
  });

  it('does not read an empty list as "this customer never ordered" when a stamp exists', async () => {
    // An empty array used to count as a real answer, so a customer with a known
    // order was reported as having none — for 45 seconds, across every agent.
    client.getOrders.mockResolvedValue([]);
    renderView(
      <LatestOrder
        vendorId="v1"
        customerId="c1"
        conversationId="conv-empty"
        stamped={summary('946641', '2026-06-25T12:00:00')}
      />,
    );
    expect(await screen.findByText(/946641/)).toBeInTheDocument();
    expect(screen.queryByText(/No orders found for this contact/)).not.toBeInTheDocument();
  });

  it('says so and still offers the manual box, instead of loading forever', async () => {
    // An external dependency that hangs must not leave a skeleton that cannot
    // be told apart from "still loading".
    client.getOrders.mockRejectedValue(new Error('proxy down'));
    renderView(<LatestOrder vendorId="v1" customerId="c1" conversationId="conv-down" />);
    expect(await screen.findByText(/Commerce data unavailable/)).toBeInTheDocument();
    expect(screen.getByLabelText('Look up an order by ID')).toBeInTheDocument();
    // One attempt, not four.
    expect(client.getOrders).toHaveBeenCalledTimes(1);
  });
});
