import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

// Stub the Yiji client factory; keep all other shared-types exports real.
const client = vi.hoisted(() => ({
  getPurchaseActivity: vi.fn(),
  getOrders: vi.fn(),
  getPaymentStatus: vi.fn(),
  getShipmentTracking: vi.fn(),
}));
vi.mock('@yiji/shared-types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@yiji/shared-types')>();
  return { ...actual, createYijiClient: () => client };
});

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
  client.getPaymentStatus.mockReset();
  client.getShipmentTracking.mockReset();
  client.getPaymentStatus.mockResolvedValue(null);
  client.getShipmentTracking.mockResolvedValue(null);
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

  it('renders lifetime activity and order cards', async () => {
    client.getPurchaseActivity.mockResolvedValue({
      lifetimeValue: 1234,
      orderCount: 3,
      lastOrderAt: '2026-01-01T00:00:00.000Z',
    });
    client.getOrders.mockResolvedValue([
      {
        orderId: 'ORD-1',
        status: 'delivered',
        placedAt: '2026-01-01T00:00:00.000Z',
        total: 99,
        currency: 'SAR',
        items: [{ sku: 's1', name: 'Widget', qty: 2, price: 49.5 }],
      },
    ]);
    renderPanel({ yijiVendorId: 'y1', externalCustomerId: 'cust-1' });
    await waitFor(() => expect(screen.getByText('lifetime value')).toBeInTheDocument());
    expect(screen.getByText('ORD-1')).toBeInTheDocument();
    expect(screen.getByText(/Widget/)).toBeInTheDocument();
  });

  it('shows the unavailable notice when there is no commerce data', async () => {
    client.getPurchaseActivity.mockResolvedValue(null);
    client.getOrders.mockResolvedValue([]);
    renderPanel({ yijiVendorId: 'y1', externalCustomerId: 'cust-1' });
    await waitFor(() =>
      expect(screen.getAllByText('Commerce data unavailable.').length).toBeGreaterThan(0),
    );
  });
});
