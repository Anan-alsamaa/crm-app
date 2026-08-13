import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    // The form formats the order date, so it reads i18n.language. Omitting it
    // made the whole component throw rather than the assertion fail, which is
    // the kind of mock gap that reads as a product bug.
    i18n: { language: 'en' },
  }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));

const hooks = vi.hoisted(() => ({
  useCreateTicketFromConversation: vi.fn(),
  useConversationAttachmentIds: vi.fn(),
  useStoreNotifyTypes: vi.fn(),
}));
vi.mock('../src/features/tickets/api.js', () => hooks);

const coupons = vi.hoisted(() => ({ useRequestCouponApproval: vi.fn() }));
vi.mock('../src/features/coupons/api.js', () => coupons);

import { CreateTicketDialog } from '../src/features/tickets/CreateTicketDialog.js';

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return {
    onClose,
    ...render(<CreateTicketDialog contactId="k1" vendorId="v1" onClose={onClose} />, {
      wrapper: Wrapper,
    }),
  };
}

/** Pick a complaint type the way an agent does: type, then choose from the list. */
async function chooseComplaintType(label: string) {
  const field = screen.getByText('Complaint type').parentElement!.querySelector('input')!;
  await userEvent.click(field);
  await userEvent.type(field, label);
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

beforeEach(() => {
  hooks.useCreateTicketFromConversation.mockReset();
  hooks.useCreateTicketFromConversation.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
  });
  hooks.useConversationAttachmentIds.mockReset();
  hooks.useConversationAttachmentIds.mockReturnValue({ data: [] });
  hooks.useStoreNotifyTypes.mockReset();
  hooks.useStoreNotifyTypes.mockReturnValue({ data: ['Missing item'] });
  coupons.useRequestCouponApproval.mockReset();
  coupons.useRequestCouponApproval.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ id: 'ca1' }),
  });
});

/** Type a value into a labelled field on the form. */
function fill(label: string, value: string) {
  const el = screen.getByText(label).parentElement!.querySelector('input, textarea')!;
  fireEvent.change(el, { target: { value } });
}

describe('CreateTicketForm', () => {
  it('renders as a page with its fields, not a modal', () => {
    renderDialog();
    // Every entry point is a route now. Announcing it as a dialog would tell a
    // screen reader the rest of the app is inert when it is simply gone.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('tickets.description')).toBeInTheDocument();
  });

  it('has no subject box — the complaint type names the ticket', () => {
    renderDialog();
    expect(screen.queryByText('tickets.subject')).not.toBeInTheDocument();
    expect(screen.getByText('Required — it names the ticket')).toBeInTheDocument();
  });

  it('puts the ticket fields inside What happened, not in a section of their own', () => {
    renderDialog();
    expect(screen.queryByText('Ticket')).not.toBeInTheDocument();
    const whatHappened = screen.getByText('What happened').closest('section')!;
    // Communication method is the last classification field; description and
    // priority follow it in the same section rather than across the page.
    expect(whatHappened).toHaveTextContent('Communication method');
    expect(whatHappened).toHaveTextContent('tickets.description');
    expect(whatHappened).toHaveTextContent('conversation.priority');
    expect(whatHappened).toHaveTextContent('Restaurant / branch');
  });

  it('closes when Cancel is clicked', async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByText('actions.cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses to save an unnamed ticket, and says which field is missing', () => {
    renderDialog();
    // Not a generic "check the highlighted fields" — that sends the agent
    // hunting across thirteen fields for the one thing that is missing.
    expect(screen.getByText('tickets.create').closest('button')).toBeDisabled();
    expect(screen.getByText('Choose a complaint type — it names the ticket')).toBeInTheDocument();
  });

  it('saves the complaint type as the subject, verbatim', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useCreateTicketFromConversation.mockReturnValue({ mutateAsync });
    const { onClose } = renderDialog();

    await chooseComplaintType('Missing item');
    await userEvent.click(screen.getByText('tickets.create'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          ticket: expect.objectContaining({
            // The STORED spelling, not the prettified label: the subject has to
            // match what every ops report groups by.
            subject: 'Missing item',
            complaint_type: 'Missing item',
            contact: 'k1',
            vendor: 'v1',
            assigned_agent: 'agent-1',
          }),
          attachmentFileIds: [],
        }),
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('warns before saving that the branch will see what is being written', async () => {
    renderDialog();
    // Silent on an unclassified form: the agent has not yet said anything that
    // would go anywhere.
    expect(screen.queryByText(/reported to the branch/)).not.toBeInTheDocument();

    await chooseComplaintType('Missing item');
    // Said next to the notes it is about, BEFORE saving — the agent is writing
    // the text that gets forwarded.
    expect(screen.getByText(/reported to the branch/)).toBeInTheDocument();
  });

  it('stays silent for a complaint type the branch is not told about', async () => {
    renderDialog();
    await chooseComplaintType('Technical issue');
    expect(screen.queryByText(/reported to the branch/)).not.toBeInTheDocument();
  });

  it('decides against the rules the form was actually showing', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ id: 'tk1', storeNotify: 'queued' });
    hooks.useCreateTicketFromConversation.mockReturnValue({ mutateAsync });
    renderDialog();

    await chooseComplaintType('Missing item');
    await userEvent.click(screen.getByText('tickets.create'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ storeNotifyTypes: ['Missing item'] }),
      ),
    );
  });

  it('keeps a coupon OFF the ticket and sends it for approval instead', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ id: 'tk1', storeNotify: 'no-store' });
    hooks.useCreateTicketFromConversation.mockReturnValue({ mutateAsync });
    const requestCoupon = vi.fn().mockResolvedValue({ id: 'ca1' });
    coupons.useRequestCouponApproval.mockReturnValue({ mutateAsync: requestCoupon });

    renderDialog();
    await chooseComplaintType('Missing item');
    fill('Coupon code', 'SORRY10');
    fill('Coupon value (SAR)', '25');
    await userEvent.click(screen.getByText('tickets.create'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    // Writing it now and asking after would make approval a formality applied
    // to money the customer has already been promised.
    const ticket = mutateAsync.mock.calls[0]![0].ticket;
    expect(ticket.coupon_code).toBeNull();
    expect(ticket.coupon_value).toBeNull();
    expect(ticket.compensation).toBeNull();

    await waitFor(() => expect(requestCoupon).toHaveBeenCalled());
    expect(requestCoupon.mock.calls[0]![0]).toMatchObject({
      ticket: 'tk1',
      coupon_code: 'SORRY10',
      coupon_value: 25,
      requested_by: 'agent-1',
    });
  });

  it('warns the agent not to promise a coupon that is not approved yet', async () => {
    renderDialog();
    expect(screen.queryByText(/supervisor has to approve/)).not.toBeInTheDocument();
    fill('Coupon code', 'SORRY10');
    expect(screen.getByText(/supervisor has to approve/)).toBeInTheDocument();
  });

  it('does not queue an approval when no coupon was given', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ id: 'tk1' });
    hooks.useCreateTicketFromConversation.mockReturnValue({ mutateAsync });
    const requestCoupon = vi.fn();
    coupons.useRequestCouponApproval.mockReturnValue({ mutateAsync: requestCoupon });

    renderDialog();
    await chooseComplaintType('Missing item');
    await userEvent.click(screen.getByText('tickets.create'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(requestCoupon).not.toHaveBeenCalled();
  });

  it('shows the name the ticket is about to get', async () => {
    renderDialog();
    await chooseComplaintType('Missing item');
    // The header is the only place the agent can read it back now that the
    // subject box is gone.
    expect(screen.getAllByText('Missing item').length).toBeGreaterThan(0);
  });
});
