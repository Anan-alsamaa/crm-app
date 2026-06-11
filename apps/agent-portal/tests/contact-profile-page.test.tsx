import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const hooks = vi.hoisted(() => ({
  useContact: vi.fn(),
  useContactConversations: vi.fn(),
  useContactTickets: vi.fn(),
}));
vi.mock('../src/features/contacts/api.js', () => hooks);
vi.mock('../src/features/contacts/CommercePanel.js', () => ({
  CommercePanel: () => <div>commerce-panel</div>,
}));
// New child that pulls in tag hooks — stub like the commerce panel.
vi.mock('../src/features/contacts/ContactTags.js', () => ({
  ContactTags: () => <div>contact-tags</div>,
}));

import { ContactProfilePage } from '../src/features/contacts/ContactProfilePage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/contacts/k1']}>
        <Routes>
          <Route path="/contacts/:id" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(<ContactProfilePage />, { wrapper: Wrapper });
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

beforeEach(() => {
  hooks.useContact.mockReset();
  hooks.useContactConversations.mockReset();
  hooks.useContactTickets.mockReset();
  hooks.useContactConversations.mockReturnValue({ data: [], isLoading: false });
  hooks.useContactTickets.mockReturnValue({ data: [], isLoading: false });
});

describe('ContactProfilePage', () => {
  it('renders the contact identity and commerce panel', () => {
    hooks.useContact.mockReturnValue({ data: contact, isLoading: false });
    renderPage();
    // Name appears in both the toolbar crumb and the identity card.
    expect(screen.getAllByText('Alice Jones').length).toBeGreaterThan(0);
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('commerce-panel')).toBeInTheDocument();
  });

  it('merges conversations and tickets into the timeline', () => {
    hooks.useContact.mockReturnValue({ data: contact, isLoading: false });
    hooks.useContactConversations.mockReturnValue({
      data: [
        {
          id: 'c1',
          status: 'open',
          priority: 'high',
          last_message_at: '2026-02-01T00:00:00.000Z',
          date_created: '2026-02-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
    });
    hooks.useContactTickets.mockReturnValue({
      data: [
        {
          id: 't1',
          subject: 'Refund please',
          status: 'open',
          priority: 'high',
          date_created: '2026-03-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('Refund please')).toBeInTheDocument();
  });
});
