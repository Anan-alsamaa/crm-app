import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

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

beforeEach(() => {
  vendorsApi.useCreateVendor.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  vendorsApi.useUpdateVendor.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  vendorsApi.useDeleteVendor.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('VendorsPage', () => {
  it('shows empty state with no vendors', () => {
    vendorsApi.useVendors.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('No vendors yet.')).toBeInTheDocument();
  });

  it('renders vendor cards', () => {
    vendorsApi.useVendors.mockReturnValue({
      data: [
        {
          id: 'v1',
          name: 'Acme',
          yiji_vendor_id: 'acme-1',
          logo: null,
          colors: { primary: '#0F8D8F', secondary: '#EC4899' },
          support_settings: null,
          status: 'active',
        },
      ],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('acme-1')).toBeInTheDocument();
  });

  it('opens the new vendor drawer', async () => {
    vendorsApi.useVendors.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    await userEvent.click(screen.getAllByText('New vendor')[0]!);
    expect(screen.getByText('Name')).toBeInTheDocument();
  });
});
