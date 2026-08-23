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

vi.mock('../src/features/tickets/ContactPicker.js', () => ({
  ContactPicker: () => <div data-testid="contact-picker" />,
}));

/** The form itself has its own tests; here it is just a marker for its inputs. */
vi.mock('../src/features/tickets/CreateTicketDialog.js', () => ({
  CreateTicketDialog: (p: {
    contactId: string | null;
    vendorId: string | null;
    contactField?: React.ReactNode;
  }) => (
    <div data-testid="ticket-form" data-contact={p.contactId ?? ''} data-vendor={p.vendorId ?? ''}>
      {p.contactField}
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

describe('NewTicketPage — raised from a chat', () => {
  it('takes the contact and vendor from the conversation, not the URL', () => {
    renderPage();
    const form = screen.getByTestId('ticket-form');
    expect(form).toHaveAttribute('data-contact', 'k1');
    expect(form).toHaveAttribute('data-vendor', 'v1');
  });

  it('offers no contact picker — the customer is not a choice here', () => {
    // Offering to change them would invite filing the ticket against someone
    // other than the person in the chat.
    renderPage();
    expect(screen.queryByTestId('contact-picker')).not.toBeInTheDocument();
  });

  it('is a page, not a dialog', () => {
    renderPage();
    // Announcing a route as a modal tells a screen reader the rest of the app
    // is inert when it is simply gone.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a skeleton while the conversation loads', () => {
    inbox.useConversation.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();
    // Rendering the empty form first would let an agent start typing against a
    // customer that has not resolved yet.
    expect(screen.queryByTestId('ticket-form')).not.toBeInTheDocument();
  });

  it('still renders the form when the conversation has no contact, with none set', () => {
    // The form disables its own submit; blanking the page would lose the branch
    // and ticket fields the agent can still fill in.
    inbox.useConversation.mockReturnValue({
      data: { id: 'c1', contact: null, vendor: { id: 'v1' } },
      isLoading: false,
    });
    renderPage();
    expect(screen.getByTestId('ticket-form')).toHaveAttribute('data-contact', '');
  });
});

describe('NewTicketPage — standalone from the nav', () => {
  beforeEach(() => {
    search.value = '';
    inbox.useConversation.mockReturnValue({ data: undefined, isLoading: false });
  });

  it('renders the form with a contact picker instead of a dead end', () => {
    renderPage();
    expect(screen.getByTestId('ticket-form')).toBeInTheDocument();
    expect(screen.getByTestId('contact-picker')).toBeInTheDocument();
  });

  it('starts with no contact chosen', () => {
    renderPage();
    expect(screen.getByTestId('ticket-form')).toHaveAttribute('data-contact', '');
  });

  it('does not wait on a conversation that was never asked for', () => {
    inbox.useConversation.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();
    // `useConversation(null)` idles as "loading"; gating on it here would leave
    // the nav entry showing a skeleton forever.
    expect(screen.getByTestId('ticket-form')).toBeInTheDocument();
  });
});
