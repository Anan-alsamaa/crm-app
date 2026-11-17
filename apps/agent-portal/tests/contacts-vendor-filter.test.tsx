import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * YIJI V2 (owner, 2026-11-16): the Contacts list gets the tenant selector the
 * other lists already have (MV-4) - one vendor or all, default all, offered
 * only when 2+ vendors are active. With v2 inactive nothing changes.
 */
const db = vi.hoisted(() => ({
  vendors: [] as Array<{ id: string; name: string; status?: string; yiji_vendor_id?: string }>,
}));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string) => ({ collection }),
}));
vi.mock('../src/lib/directus.js', () => ({
  directus: { request: vi.fn(async () => db.vendors) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => ({ can: () => false }) }));

const CONTACTS = [
  {
    id: 'c1',
    name: 'Ali V1',
    email: null,
    phone: '0500000001',
    external_customer_id: 'g-1',
    vendor: { id: 'v-yiji', name: 'Yiji', yiji_vendor_id: '1' },
    date_created: '2026-11-01T00:00:00Z',
  },
  {
    id: 'c2',
    name: 'Sara V2',
    email: null,
    phone: '0500000201',
    external_customer_id: '2000000001',
    vendor: { id: 'v-two', name: 'Yiji V2', yiji_vendor_id: '2' },
    date_created: '2026-11-02T00:00:00Z',
  },
];
vi.mock('../src/features/contacts/api.js', () => ({
  useContacts: () => ({ data: CONTACTS, isLoading: false }),
}));

import { ContactsPage } from '../src/features/contacts/ContactsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ContactsPage />, { wrapper });
}

beforeEach(() => {
  db.vendors = [];
});

describe('contacts tenant filter', () => {
  it('is absent with one active vendor (v2 inactive): every contact listed, nothing new on screen', async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active', yiji_vendor_id: '1' },
      { id: 'v-two', name: 'Yiji V2', status: 'inactive', yiji_vendor_id: '2' },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByText('Ali V1')).toBeTruthy());
    expect(screen.getByText('Sara V2')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('combobox', { name: 'Vendor' })).toBeNull();
  });

  it('appears with two active vendors, defaults to all, and narrows to one tenant', async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active', yiji_vendor_id: '1' },
      { id: 'v-two', name: 'Yiji V2', status: 'active', yiji_vendor_id: '2' },
    ];
    renderPage();
    const trigger = await screen.findByRole('combobox', { name: 'Vendor' });
    expect(screen.getByText('Ali V1')).toBeTruthy();
    expect(screen.getByText('Sara V2')).toBeTruthy();
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('button', { name: 'Yiji V2' }));
    await waitFor(() => expect(screen.queryByText('Ali V1')).toBeNull());
    expect(screen.getByText('Sara V2')).toBeTruthy();
  });
});
