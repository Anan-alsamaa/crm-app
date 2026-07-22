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
}));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce: client }));

import { LatestOrder, CustomerOrders } from '../src/features/commerce/OrderViews.js';

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
    await waitFor(() => expect(screen.getByText('No orders yet.')).toBeInTheDocument());
  });

  it('shows "unavailable" when the commerce proxy errors', async () => {
    client.getOrders.mockRejectedValue(new Error('commerce 500'));
    renderView(<LatestOrder vendorId="v1" customerId="cust-guid" />);
    await waitFor(() => expect(screen.getByText('Commerce data unavailable.')).toBeInTheDocument());
  });

  it('renders nothing (and runs no query) without ids', () => {
    const { container } = renderView(<LatestOrder vendorId="" customerId="" />);
    expect(container).toBeEmptyDOMElement();
    expect(client.getOrders).not.toHaveBeenCalled();
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
    await waitFor(() => expect(screen.getByText('Commerce data unavailable.')).toBeInTheDocument());
  });

  it('renders nothing without ids', () => {
    const { container } = renderView(<CustomerOrders vendorId="v1" customerId="" />);
    expect(container).toBeEmptyDOMElement();
    expect(client.getOrders).not.toHaveBeenCalled();
  });
});
