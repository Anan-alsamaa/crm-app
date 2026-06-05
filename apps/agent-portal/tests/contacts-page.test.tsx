import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const hooks = vi.hoisted(() => ({ useContacts: vi.fn() }));
vi.mock('../src/features/contacts/api.js', () => hooks);

import { ContactsPage } from '../src/features/contacts/ContactsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<ContactsPage />, { wrapper: Wrapper });
}

const contact = {
  id: 'k1',
  external_customer_id: 'EXT-1',
  name: 'Alice Jones',
  phone: '555-1000',
  email: 'alice@example.com',
  metadata: null,
  vendor: { id: 'v1', name: 'Acme', yiji_vendor_id: 'y1' },
  date_created: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => hooks.useContacts.mockReset());

describe('ContactsPage', () => {
  it('shows the empty state when there are no contacts', () => {
    hooks.useContacts.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('No contacts yet.')).toBeInTheDocument();
  });

  it('renders contact cards', () => {
    hooks.useContacts.mockReturnValue({ data: [contact], isLoading: false });
    renderPage();
    expect(screen.getByText('Alice Jones')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('filters the list as the user searches', async () => {
    hooks.useContacts.mockReturnValue({
      data: [contact, { ...contact, id: 'k2', name: 'Bob Smith', email: 'bob@example.com' }],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Search…'), 'alice');
    expect(screen.getByText('Alice Jones')).toBeInTheDocument();
    expect(screen.queryByText('Bob Smith')).not.toBeInTheDocument();
  });
});
