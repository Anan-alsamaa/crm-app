import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const navigateSpy = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => ({ value: '?conversation=c1' }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    useSearchParams: () => [new URLSearchParams(search.value)],
  };
});

const inbox = vi.hoisted(() => ({
  useConversation: vi.fn(),
  conversationVendorId: (c: { vendor?: { id?: string } | string | null }) =>
    typeof c?.vendor === 'string' ? c.vendor : (c?.vendor?.id ?? ''),
}));
vi.mock('../src/features/inbox/api.js', () => inbox);

/** The form itself is covered by its own tests; here it is just a marker. */
vi.mock('../src/features/tickets/CreateTicketDialog.js', () => ({
  CreateTicketDialog: (p: { chrome?: string; contactId: string; vendorId: string }) => (
    <div data-testid="ticket-form" data-chrome={p.chrome}>
      form for {p.contactId}/{p.vendorId}
    </div>
  ),
}));

import { NewTicketPage } from '../src/features/tickets/NewTicketPage.js';

const wrap = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const renderPage = () => render(<NewTicketPage />, { wrapper: wrap });

beforeEach(() => {
  navigateSpy.mockClear();
  search.value = '?conversation=c1';
  inbox.useConversation.mockReturnValue({
    data: { id: 'c1', contact: { id: 'k1' }, vendor: { id: 'v1' } },
    isLoading: false,
  });
});

describe('NewTicketPage', () => {
  it('renders the ticket form as a page, not a modal', () => {
    renderPage();
    expect(screen.getByTestId('ticket-form')).toHaveAttribute('data-chrome', 'page');
    // A page is not a dialog: announcing one would tell a screen reader the rest
    // of the app is inert when it is simply gone.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('takes the contact and vendor from the conversation, not the URL', () => {
    renderPage();
    expect(screen.getByTestId('ticket-form')).toHaveTextContent('form for k1/v1');
  });

  it('refuses to render the form when the conversation has no contact', () => {
    // Filling in fifteen fields and only then failing on save loses the work.
    inbox.useConversation.mockReturnValue({
      data: { id: 'c1', contact: null, vendor: { id: 'v1' } },
      isLoading: false,
    });
    renderPage();
    expect(screen.queryByTestId('ticket-form')).not.toBeInTheDocument();
    expect(screen.getByText(/no conversation behind it/i)).toBeInTheDocument();
  });

  it('refuses to render the form when the link carries no conversation at all', () => {
    search.value = '';
    inbox.useConversation.mockReturnValue({ data: undefined, isLoading: false });
    renderPage();
    expect(screen.queryByTestId('ticket-form')).not.toBeInTheDocument();
  });

  it('shows a skeleton while the conversation loads', () => {
    inbox.useConversation.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();
    // Not the empty state: "no conversation" and "not loaded yet" look identical
    // to a user, and showing the dead end first reads as a broken link.
    expect(screen.queryByText(/no conversation behind it/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('ticket-form')).not.toBeInTheDocument();
  });
});
