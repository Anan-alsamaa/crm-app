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

  /*
   * MV-1 (EMA-70): the owner edits the vendor's NON-SECRET integration
   * settings in the drawer; credentials are never offered.
   */
  describe('Integration settings', () => {
    const yiji = {
      id: 'v-yiji',
      name: 'Yiji',
      yiji_vendor_id: '1',
      logo: null,
      colors: { primary: '#0F8D8F', secondary: '#EC4899' },
      support_settings: null,
      status: 'active',
      platform: 'yiji',
      api_base_url: 'https://order.yiji-app.com',
      admin_api_url: 'https://admin.yiji-app.com',
      tenant_id: '7',
      brand_id: null,
      webhook_path_key: 'yiji',
      notify_settings: { notifyTitle: 'Yiji Support' },
    };

    it('renders the saved settings and the no-secrets note', async () => {
      vendorsApi.useVendors.mockReturnValue({ data: [yiji], isLoading: false });
      renderPage();
      await userEvent.click(screen.getByText('Yiji'));
      expect(screen.getByText('Integration')).toBeInTheDocument();
      expect(screen.getByDisplayValue('https://order.yiji-app.com')).toBeInTheDocument();
      expect(screen.getByDisplayValue('https://admin.yiji-app.com')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Yiji Support')).toBeInTheDocument();
      expect(screen.getByText(/Credentials .* are not stored here/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/password/i)).toBeNull();
    });

    it('saves edited settings with the rest of the vendor (blank -> null)', async () => {
      const mutateAsync = vi.fn().mockResolvedValue({});
      vendorsApi.useUpdateVendor.mockReturnValue({ mutateAsync });
      vendorsApi.useVendors.mockReturnValue({ data: [yiji], isLoading: false });
      renderPage();
      await userEvent.click(screen.getByText('Yiji'));
      await userEvent.clear(screen.getByDisplayValue('7'));
      const webhook = screen.getByDisplayValue('yiji');
      await userEvent.clear(webhook);
      await userEvent.type(webhook, 'yiji-main');
      await userEvent.click(screen.getByText('actions.save'));
      expect(mutateAsync).toHaveBeenCalledTimes(1);
      const patch = mutateAsync.mock.calls[0]![0].patch;
      expect(patch).toMatchObject({
        platform: 'yiji',
        api_base_url: 'https://order.yiji-app.com',
        admin_api_url: 'https://admin.yiji-app.com',
        webhook_path_key: 'yiji-main',
        tenant_id: null,
        brand_id: null,
        notify_settings: { notifyTitle: 'Yiji Support' },
        yiji_vendor_id: '1',
      });
    });

    it('refuses an invalid webhook key and does not save', async () => {
      const mutateAsync = vi.fn().mockResolvedValue({});
      vendorsApi.useUpdateVendor.mockReturnValue({ mutateAsync });
      vendorsApi.useVendors.mockReturnValue({ data: [yiji], isLoading: false });
      renderPage();
      await userEvent.click(screen.getByText('Yiji'));
      const webhook = screen.getByDisplayValue('yiji');
      await userEvent.clear(webhook);
      await userEvent.type(webhook, 'Not Valid!');
      await userEvent.click(screen.getByText('actions.save'));
      expect(
        await screen.findByText('Lowercase letters, digits and dashes only'),
      ).toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();
    });
  });
});
