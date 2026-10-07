import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CouponRequestDialog } from '../src/features/coupons/CouponRequestDialog.js';

/**
 * SOME CUSTOMERS WILL NOT ACCEPT AN APP COUPON (owner, 2026-10-01).
 *
 * They want a refund — commonly the ones who complained over WhatsApp. The
 * compensation still has to be RECORDED and approved, because it was agreed with
 * the customer and is honoured another way; it simply must not be pushed to Yiji.
 *
 * The backend for this already existed and is live: `delivery_excluded` is
 * checked by `coupon-push` BEFORE the approved check, so an excluded row is inert
 * however the job was queued (including a Retry) and counts as "not owed" rather
 * than failed — see `services/workers/tests/coupon-push.test.ts`. What was
 * missing was any way for an agent to SET it: the dialog never sent the field, so
 * it was always false.
 *
 * These tests are therefore about the one thing that was broken — the choice
 * reaching the row — and about the default staying safe.
 */

const mutateAsync = vi.fn();

vi.mock('../src/features/coupons/api.js', () => ({
  useRequestCouponApproval: () => ({ mutateAsync, isPending: false }),
  useCouponCodeTaken: () => ({ data: false }),
}));

vi.mock('../src/features/tickets/option-lists.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/tickets/option-lists.js')>(
    '../src/features/tickets/option-lists.js',
  );
  return {
    ...actual,
    useOptionLists: () => ({
      data: {
        issuing_side: ['Operations', 'Marketing'],
        delivery_type: ['All', 'Van'],
        coupon_type: ['Private', 'Public'],
        discount_category: ['Amount', 'Percentage'],
      },
    }),
  };
});

function renderDialog(overrides: Partial<Parameters<typeof CouponRequestDialog>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CouponRequestDialog
        open
        onClose={() => {}}
        ticketId="t1"
        contactId="c1"
        customerPhone="+966501234567"
        description="Order arrived cold."
        brandId="Chick N Dip"
        restaurantId="store-9"
        requestedBy="u1"
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

/** The minimum a request needs before it can be sent. */
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText(/issuing side/i));
  await user.click(await screen.findByRole('button', { name: 'Operations' }));
  await user.click(screen.getByLabelText(/delivery type/i));
  await user.click(await screen.findByRole('button', { name: 'Van' }));
  const val = screen.getByLabelText(/coupon value/i);
  await user.clear(val);
  await user.type(val, '25');
  await waitFor(() => expect((val as HTMLInputElement).value).toBe('25'));
}

const send = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /send for approval/i }));

/* A combobox BUTTON, not a labelled input — `SelectMenu` names itself with
   `aria-label`, so that is what this queries. */
const withholdSelect = () => screen.getByRole('combobox', { name: /assign the coupon on yiji/i });

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({});
});

describe('withholding a coupon from the Yiji app', () => {
  /*
   * THE DEFAULT IS THE SAFE ONE. An agent who never touches the field must get
   * exactly the previous behaviour — the coupon goes to the customer.
   */
  it('delivers by default, with no reason attached', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await send(user);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({
      delivery_excluded: false,
      delivery_excluded_reason: null,
    });
  });

  it('offers the choice, opening on “send it”', () => {
    renderDialog();
    expect(withholdSelect()).toBeInTheDocument();
    expect(withholdSelect()).toHaveTextContent(/^yes$/i);
  });

  /* THE REPORTED CASE: a refund customer. */
  it('sends the withhold flag when the agent chooses not to deliver', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await user.click(withholdSelect());
    await user.click(await screen.findByRole('button', { name: /don.t assign to customer/i }));
    await send(user);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({ delivery_excluded: true });
  });

  /* The rest of the request is untouched — it still goes for approval with its
     code and value, which is the whole point: the compensation is recorded. */
  it('still sends a complete request for approval', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await user.click(withholdSelect());
    await user.click(await screen.findByRole('button', { name: /don.t assign to customer/i }));
    await send(user);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const sent = mutateAsync.mock.calls[0]![0];
    expect(sent).toMatchObject({
      delivery_excluded: true,
      coupon_value: 25,
      issuing_side: 'Operations',
      ticket: 't1',
      contact: 'c1',
    });
    expect(String(sent.coupon_code)).toMatch(/\w/);
  });

  /* The reason box exists only where it means something. */
  it('asks for a reason only once delivery is withheld', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.queryByLabelText(/why is it not being sent/i)).not.toBeInTheDocument();
    await user.click(withholdSelect());
    await user.click(await screen.findByRole('button', { name: /don.t assign to customer/i }));
    expect(screen.getByLabelText(/why is it not being sent/i)).toBeInTheDocument();
  });

  it('carries the reason when one is given', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await user.click(withholdSelect());
    await user.click(await screen.findByRole('button', { name: /don.t assign to customer/i }));
    await user.type(
      screen.getByLabelText(/why is it not being sent/i),
      'Customer insisted on a refund',
    );
    await send(user);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({
      delivery_excluded: true,
      delivery_excluded_reason: 'Customer insisted on a refund',
    });
  });

  /* OPTIONAL, on the owner's instruction: an agent on a call must not be blocked
     from recording the compensation just because they have not typed a reason. */
  it('does not block sending when no reason is typed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await user.click(withholdSelect());
    await user.click(await screen.findByRole('button', { name: /don.t assign to customer/i }));
    await send(user);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({
      delivery_excluded: true,
      delivery_excluded_reason: null,
    });
  });

  /*
   * A REASON MUST NOT SURVIVE A CHANGE OF MIND. "Why it was withheld" left on a
   * coupon that IS being delivered reads as a contradiction on the supervisor's
   * card, and they decide on what that card says.
   */
  it('drops the reason if the agent switches back to sending it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user);
    await user.click(withholdSelect());
    await user.click(await screen.findByRole('button', { name: /don.t assign to customer/i }));
    await user.type(screen.getByLabelText(/why is it not being sent/i), 'refund');
    // Changed their mind.
    await user.click(withholdSelect());
    await user.click(await screen.findByRole('button', { name: /^yes$/i }));
    await send(user);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({
      delivery_excluded: false,
      delivery_excluded_reason: null,
    });
  });
});
