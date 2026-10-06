import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  useAuth: () => ({ user: { id: 'agent-1' }, can: () => true }),
}));

const hooks = vi.hoisted(() => ({
  useCreateTicketFromConversation: vi.fn(),
  useConversationAttachmentIds: vi.fn(),
  useStoreNotifyTypes: vi.fn(),
}));
vi.mock('../src/features/tickets/api.js', () => hooks);

const coupons = vi.hoisted(() => ({
  useRequestCouponApproval: vi.fn(),
  useCouponCodeTaken: vi.fn(() => ({ data: false })),
}));
vi.mock('../src/features/coupons/api.js', () => coupons);

/*
 * THE BRANCH IS NOW REQUIRED (owner, 2026-09-28), so the form cannot submit
 * until one is chosen — every test that saves a ticket has to pick one.
 *
 * `useStoreMatch` is stubbed rather than the SDK because the real hook builds
 * an index and matches against it; what these tests are about is the FORM, and
 * the matching has its own tests in `packages/shared-types`.
 */
const storeHooks = vi.hoisted(() => ({
  store: {
    id: 's1',
    code: 'LCP-001',
    name: 'Test Branch',
    city: 'Riyadh',
    areaManager: 'AM',
    chainManager: 'CM',
    brandName: 'Casa Pasta',
    brandYijiName: null,
    yijiRestaurantId: '9',
  },
}));
vi.mock('../src/features/tickets/useStoreMatch.js', () => ({
  useStores: () => ({ data: [storeHooks.store], isLoading: false }),
  useStoreIndex: () => ({ index: {}, isLoading: false, count: 1 }),
  toStoreRecord: (s: unknown) => s,
  /* Resolved from the order, which is the ordinary case: the picker shows it as
     inferred and the form is submittable without the agent touching it. */
  useOrderStore: () => ({
    store: storeHooks.store,
    via: 'yiji_id',
    restaurantName: 'Test Branch',
    brandName: 'Casa Pasta',
    city: 'Riyadh',
    areaManager: 'AM',
    chainManager: 'CM',
  }),
}));

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

/** Pick a ticket type the way an agent does: type, then choose from the list. */
async function chooseComplaintType(label: string) {
  const field = screen.getByText('Ticket type').parentElement!.querySelector('input')!;
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

describe('CreateTicketForm', () => {
  it('renders as a page with its fields, not a modal', () => {
    renderDialog();
    // Every entry point is a route now. Announcing it as a dialog would tell a
    // screen reader the rest of the app is inert when it is simply gone.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('tickets.description')).toBeInTheDocument();
  });

  it('has no subject box — the ticket type names the ticket', () => {
    renderDialog();
    expect(screen.queryByText('tickets.subject')).not.toBeInTheDocument();
    expect(screen.getByText('Required — it names the ticket')).toBeInTheDocument();
  });

  it('puts the ticket fields inside What happened, not in a section of their own', () => {
    renderDialog();
    expect(screen.queryByText('Ticket')).not.toBeInTheDocument();
    const whatHappened = screen.getByText('What happened').closest('section')!;
    // Ticket source is the last classification field; description and priority
    // follow it in the same section rather than across the page. It used to be
    // "Communication method", removed as a duplicate of this very field
    // (owner, 2026-09-21).
    expect(whatHappened).toHaveTextContent('Ticket source');
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
    expect(screen.getByText('Choose a ticket type — it names the ticket')).toBeInTheDocument();
  });

  it('saves the ticket type as the subject, verbatim', async () => {
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

  it('stays silent for a ticket type the branch is not told about', async () => {
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

  it('asks about a coupon in ONE place, not two', () => {
    // The coupon inputs used to sit inline on this form as well as in the
    // dialog, which gave an agent two places to answer the same question with
    // nothing reconciling the answers. The dialog owns it now; the form offers
    // the decision and the button that opens it.
    renderDialog();
    expect(screen.queryByText('Coupon code')).not.toBeInTheDocument();
    expect(screen.queryByText('Coupon value (SAR)')).not.toBeInTheDocument();
    expect(screen.queryByText('Coupon %')).not.toBeInTheDocument();
    expect(screen.getByText(/assign a coupon/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create coupon/i })).toBeDisabled();
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

  /*
   * NO BRANCH, NO SAVE (owner, 2026-09-28: "not be allowed to create a ticket
   * without the branch").
   *
   * A ticket saved without one is dropped from the ticket breakdown as
   * incomplete and never appears — so the form has to refuse it, and say WHY
   * rather than leaving a dead button an agent has to guess at.
   *
   * This overrides the module mock for one test so no branch resolves, which is
   * a walk-in with no order behind it.
   */
  it('will not save without a branch, and says why', async () => {
    const mod = await import('../src/features/tickets/useStoreMatch.js');
    /* `StoreMatch`'s display fields are plain strings, not nullable — an
       unmatched order carries empty ones, not nulls. */
    const spy = vi.spyOn(mod, 'useOrderStore').mockReturnValue({
      store: null,
      via: 'none',
      brandName: '',
      city: '',
      areaManager: '',
      chainManager: '',
      restaurantName: '',
    });
    try {
      renderDialog();
      await chooseComplaintType('Missing item');
      expect(screen.getByText(/Choose the branch/i)).toBeTruthy();
      /* By type, not by name: "create" also matches the coupon button, and the
         i18n mock renders this one's label as its bare key. */
      const save = document.querySelector('button[type="submit"]');
      expect(save?.hasAttribute('disabled')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
