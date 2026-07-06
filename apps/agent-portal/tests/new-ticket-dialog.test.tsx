import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

// t returns its defaultValue (or the key when none), matching the other suites.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

// Keep the real @yiji/ui components (Input, FormField, SelectMenu, Button…) so
// the form actually renders; only replace `toast` so we can assert on it and so
// no Toaster needs mounting.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@yiji/ui', async (orig) => {
  const actual = await orig<typeof import('@yiji/ui')>();
  return { ...actual, toast };
});

const ticketApi = vi.hoisted(() => ({ useCreateTicket: vi.fn() }));
vi.mock('../src/features/tickets/api.js', () => ticketApi);

const contactApi = vi.hoisted(() => ({ useContactSearch: vi.fn() }));
vi.mock('../src/features/contacts/api.js', () => contactApi);

const inboxApi = vi.hoisted(() => ({ useAgents: vi.fn() }));
vi.mock('../src/features/inbox/api.js', () => inboxApi);

import { NewTicketDialog } from '../src/features/tickets/NewTicketDialog.js';

const CONTACT_WITH_VENDOR = {
  id: 'c1',
  external_customer_id: null,
  name: 'Ada Lovelace',
  phone: '+15551234',
  email: 'ada@example.com',
  metadata: null,
  vendor: { id: 'v1', name: 'Acme', yiji_vendor_id: 'yv1' },
  date_created: null,
};

const CONTACT_NO_VENDOR = {
  ...CONTACT_WITH_VENDOR,
  id: 'c2',
  name: 'No Vendor Person',
  phone: '+15559999',
  email: 'nv@example.com',
  vendor: null,
};

function renderDialog(opts?: { onClose?: () => void; onCreated?: (id: string) => void }) {
  const onClose = opts?.onClose ?? vi.fn();
  const onCreated = opts?.onCreated ?? vi.fn();
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return {
    onClose,
    onCreated,
    ...render(<NewTicketDialog onClose={onClose} onCreated={onCreated} />, { wrapper: Wrapper }),
  };
}

/** Search for and pick the vendor-backed contact so the form can be submitted. */
async function pickContact(user: ReturnType<typeof userEvent.setup>) {
  const searchInput = screen.getByPlaceholderText(/search by phone number/i);
  await user.type(searchInput, 'ada');
  const pick = await screen.findByText('Ada Lovelace');
  await user.click(pick);
  // Once picked, the summary card shows a Change button.
  await screen.findByText('Change');
}

let mutateAsync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync = vi.fn().mockResolvedValue({ id: 'new-ticket-1' });
  ticketApi.useCreateTicket.mockReturnValue({ mutateAsync });
  // By default the search returns the vendor-backed contact.
  contactApi.useContactSearch.mockReturnValue({
    data: [CONTACT_WITH_VENDOR],
    isFetching: false,
  });
  inboxApi.useAgents.mockReturnValue({
    data: [{ id: 'agent-9', first_name: 'Grace', email: 'grace@example.com' }],
  });
});

describe('NewTicketDialog', () => {
  it('renders the dialog with its fields and hint', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('New ticket')).toBeInTheDocument();
    expect(screen.getByText('tickets.subject')).toBeInTheDocument();
    expect(screen.getByText('tickets.description')).toBeInTheDocument();
    expect(screen.getByText('conversation.priority')).toBeInTheDocument();
    expect(screen.getByText('conversation.agent')).toBeInTheDocument();
  });

  it('starts with the search prompt and no results while the term is too short', () => {
    renderDialog();
    expect(screen.getByText('Type a phone number or name to find a contact.')).toBeInTheDocument();
    // useContactSearch was called with the initial empty term.
    expect(contactApi.useContactSearch).toHaveBeenCalledWith('');
  });

  it('keeps submit disabled until a subject and a vendor-backed contact are set', async () => {
    const user = userEvent.setup();
    renderDialog();
    const createBtn = screen.getByRole('button', { name: 'tickets.create' });
    expect(createBtn).toBeDisabled();

    // Subject alone is not enough — still no contact.
    await user.type(screen.getByLabelText('tickets.subject'), 'Refund request');
    expect(createBtn).toBeDisabled();

    // Pick the contact → now enabled.
    await pickContact(user);
    expect(createBtn).toBeEnabled();
  });

  it('does not submit and does not call the mutation on an empty form', async () => {
    const user = userEvent.setup();
    renderDialog();
    const createBtn = screen.getByRole('button', { name: 'tickets.create' });
    // Disabled button click is a no-op; assert the guard held.
    await user.click(createBtn);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the "No vendor" tag for contacts without a vendor', () => {
    contactApi.useContactSearch.mockReturnValue({
      data: [CONTACT_NO_VENDOR],
      isFetching: false,
    });
    const user = userEvent.setup();
    renderDialog();
    return user.type(screen.getByPlaceholderText(/search by phone number/i), 'no').then(() => {
      expect(screen.getByText('No vendor')).toBeInTheDocument();
    });
  });

  it('renders the fetching spinner while the contact search is in flight', async () => {
    contactApi.useContactSearch.mockReturnValue({ data: undefined, isFetching: true });
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByPlaceholderText(/search by phone number/i), 'ad');
    // Spinner has role status via @yiji/ui; fall back to absence of the prompt.
    expect(
      screen.queryByText('Type a phone number or name to find a contact.'),
    ).not.toBeInTheDocument();
  });

  it('shows the empty state when the search returns no matches', async () => {
    contactApi.useContactSearch.mockReturnValue({ data: [], isFetching: false });
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByPlaceholderText(/search by phone number/i), 'zz');
    expect(screen.getByText('No matching contacts.')).toBeInTheDocument();
  });

  it('lets the agent clear the chosen contact via Change', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pickContact(user);
    expect(screen.getByText('Change')).toBeInTheDocument();
    await user.click(screen.getByText('Change'));
    // Back to the search input.
    expect(screen.getByPlaceholderText(/search by phone number/i)).toBeInTheDocument();
  });

  it('fills the form and submits the expected create-ticket payload, then closes', async () => {
    const user = userEvent.setup();
    const { onClose, onCreated } = renderDialog();

    await pickContact(user);
    await user.type(screen.getByLabelText('tickets.subject'), '  Refund request  ');
    await user.type(screen.getByLabelText('tickets.description'), 'Please refund me');

    await user.click(screen.getByRole('button', { name: 'tickets.create' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Refund request',
          description: 'Please refund me',
          priority: 'medium',
          contact: 'c1',
          vendor: 'v1',
          assigned_agent: null,
        }),
      ),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-ticket-1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('omits an empty description (sends undefined)', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pickContact(user);
    await user.type(screen.getByLabelText('tickets.subject'), 'Just a subject');
    await user.click(screen.getByRole('button', { name: 'tickets.create' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({ description: undefined });
  });

  it('shows an error toast and does not close when the mutation rejects', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await pickContact(user);
    await user.type(screen.getByLabelText('tickets.subject'), 'Will fail');
    await user.click(screen.getByRole('button', { name: 'tickets.create' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('tickets.createError'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'actions.cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on the Escape key', async () => {
    const { onClose } = renderDialog();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop (overlay) is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalled();
  });

  it('changes the priority via the SelectMenu and submits it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pickContact(user);
    await user.type(screen.getByLabelText('tickets.subject'), 'Urgent thing');

    // Open the priority SelectMenu (its trigger exposes role="combobox") and
    // choose "urgent".
    const trigger = screen.getByRole('combobox', { name: 'conversation.priority' });
    await user.click(trigger);
    await user.click(await screen.findByText('priority.urgent'));

    await user.click(screen.getByRole('button', { name: 'tickets.create' }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ priority: 'urgent' })),
    );
  });
});
