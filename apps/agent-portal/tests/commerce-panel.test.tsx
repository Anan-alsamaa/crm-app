import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

// Stub the commerce proxy client (the panel calls the ai-gateway proxy via
// lib/commerce-client, not the Yiji API directly). The order LIST returns
// summaries (no items); the SINGLE order (getOrder) carries the line items and
// is fetched lazily when a row is expanded.
const client = vi.hoisted(() => ({
  getPurchaseActivity: vi.fn(),
  getOrders: vi.fn(),
  getOrder: vi.fn(),
}));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce: client }));

import { CommercePanel } from '../src/features/contacts/CommercePanel.js';

function renderPanel(props: { yijiVendorId: string; externalCustomerId: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<CommercePanel {...props} />, { wrapper: Wrapper });
}

beforeEach(() => {
  client.getPurchaseActivity.mockReset();
  client.getOrders.mockReset();
  client.getOrder.mockReset();
});

describe('CommercePanel', () => {
  it('shows the no-link notice when ids are missing', () => {
    renderPanel({ yijiVendorId: '', externalCustomerId: '' });
    expect(
      screen.getByText('No Yiji customer linked — commerce data not available.'),
    ).toBeInTheDocument();
    // No queries run without ids.
    expect(client.getOrders).not.toHaveBeenCalled();
  });

  it('renders lifetime activity and the latest order ids, expanding to show items', async () => {
    client.getPurchaseActivity.mockResolvedValue({
      lifetimeValue: 1234,
      orderCount: 3,
      lastOrderAt: '2026-01-01T00:00:00.000Z',
    });
    // List = summary only (no items).
    client.getOrders.mockResolvedValue([
      {
        orderId: 'ORD-1',
        status: 'delivered',
        placedAt: '2026-01-01T00:00:00.000Z',
        total: 99,
        currency: 'SAR',
        items: [],
      },
    ]);
    // Single order = full detail with line items (fetched on expand).
    client.getOrder.mockResolvedValue({
      orderId: 'ORD-1',
      status: 'delivered',
      placedAt: '2026-01-01T00:00:00.000Z',
      total: 99,
      currency: 'SAR',
      items: [{ sku: 's1', name: 'Widget', qty: 2, price: 49.5 }],
    });
    renderPanel({ yijiVendorId: 'y1', externalCustomerId: 'cust-1' });

    await waitFor(() => expect(screen.getByText('lifetime value')).toBeInTheDocument());
    // Collapsed row shows the order id; items are NOT fetched yet.
    const row = await screen.findByRole('button', { name: /ORD-1/ });
    expect(client.getOrder).not.toHaveBeenCalled();

    // Expanding the row lazily loads and shows the items.
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText(/Widget/)).toBeInTheDocument());
    expect(client.getOrder).toHaveBeenCalledWith('y1', 'ORD-1');
  });

  it('shows the unavailable notice when there is no commerce data', async () => {
    client.getPurchaseActivity.mockResolvedValue(null);
    client.getOrders.mockResolvedValue([]);
    renderPanel({ yijiVendorId: 'y1', externalCustomerId: 'cust-1' });
    await waitFor(() => expect(screen.getByText('Commerce data unavailable.')).toBeInTheDocument());
  });
});
