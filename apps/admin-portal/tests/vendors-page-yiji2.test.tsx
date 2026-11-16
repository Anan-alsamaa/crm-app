import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/*
 * YIJI V2 (owner, 2026-11-16): the Vendors page offers the `yiji2` platform
 * and shows a v2 vendor row with its platform, so the owner can create and
 * later activate the second tenant without a code change.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const vendorsApi = vi.hoisted(() => ({
  useVendors: vi.fn(),
  useCreateVendor: vi.fn(),
  useUpdateVendor: vi.fn(),
  useDeleteVendor: vi.fn(),
}));
vi.mock('../src/features/vendors/api.js', () => vendorsApi);

import { VendorsPage } from '../src/features/vendors/VendorsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<VendorsPage />, { wrapper: Wrapper });
}

const V2_ROW = {
  id: 'v2',
  name: 'Yiji V2',
  yiji_vendor_id: '2',
  logo: null,
  colors: { primary: '#1F6FEB', secondary: '#F2B705' },
  support_settings: null,
  status: 'inactive',
  platform: 'yiji2',
  api_base_url: 'https://api.staging.yiji.app',
  admin_api_url: null,
  tenant_id: null,
  brand_id: null,
  notify_settings: null,
  webhook_path_key: 'yiji2',
};

beforeEach(() => {
  vendorsApi.useCreateVendor.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  vendorsApi.useUpdateVendor.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  vendorsApi.useDeleteVendor.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('VendorsPage and the yiji2 platform', () => {
  it('offers Yiji v2 as a platform for a new vendor', async () => {
    vendorsApi.useVendors.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    await userEvent.click(screen.getAllByText('New vendor')[0]!);
    const select = screen.getByLabelText('Platform') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['yiji', 'yiji2', 'mock']);
    expect(select.value).toBe('yiji');
  });

  it('shows an existing v2 vendor with its platform selected', async () => {
    vendorsApi.useVendors.mockReturnValue({ data: [V2_ROW], isLoading: false });
    renderPage();
    await userEvent.click(screen.getByText('Yiji V2'));
    const select = screen.getByLabelText('Platform') as HTMLSelectElement;
    expect(select.value).toBe('yiji2');
  });
});
