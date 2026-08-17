import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CouponRequestDialog } from '../src/features/coupons/CouponRequestDialog.js';

const mutateAsync = vi.fn();

vi.mock('../src/features/coupons/api.js', () => ({
  useRequestCouponApproval: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('../src/features/tickets/option-lists.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/tickets/option-lists.js')>(
    '../src/features/tickets/option-lists.js',
  );
  return {
    ...actual,
    // The live lists an admin edits. Deliberately includes a value that is NOT
    // in the seeded fallback, to prove the form offers what operations added.
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

describe('CouponRequestDialog', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
  });

  it('opens with the customer phone as the title — what operations search by', () => {
    renderDialog();
    expect(screen.getByDisplayValue('+966501234567')).toBeInTheDocument();
  });

  it('carries the complaint over as the reason rather than asking again', () => {
    renderDialog();
    expect(screen.getByDisplayValue('Order arrived cold.')).toBeInTheDocument();
  });

  it('generates a code the agent cannot mistype, and can replace', async () => {
    renderDialog();
    const first = (screen.getByLabelText(/coupon code/i) as HTMLInputElement).value;
    expect(first).toMatch(/^[A-Z]{3,6}-[A-Z2-9]{8}$/);
    await userEvent.click(screen.getByRole('button', { name: /new code/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/coupon code/i) as HTMLInputElement).value).not.toBe(first),
    );
  });

  it('never offers a time field — a coupon runs for whole days', () => {
    renderDialog();
    expect(screen.queryByLabelText(/time/i)).not.toBeInTheDocument();
  });

  it('does not let the agent choose the branch', () => {
    // The coupon belongs to the branch the complaint was about. Offering a
    // picker would let an agent compensate against the wrong one.
    renderDialog();
    expect(screen.queryByLabelText(/brand/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/restaurant/i)).not.toBeInTheDocument();
  });

  it('refuses to send until the dropdowns operations owns are answered', () => {
    renderDialog();
    // issuing_side and delivery_type start empty, so the request is incomplete.
    expect(screen.getByRole('button', { name: /send for approval/i })).toBeDisabled();
  });

  it('sends the branch it resolved, and only the money field the category implies', async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    await userEvent.click(screen.getByLabelText(/delivery type/i));
    // "Van" exists only in the live list — proving the form reads option_lists
    // rather than a compiled-in enum.
    await userEvent.click(await screen.findByRole('button', { name: 'Van' }));

    const val = screen.getByLabelText(/coupon value/i);
    await userEvent.clear(val);
    await userEvent.type(val, '25');
    await waitFor(() => expect((val as HTMLInputElement).value).toBe('25'));

    await userEvent.click(screen.getByRole('button', { name: /send for approval/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const sent = mutateAsync.mock.calls[0]![0];
    expect(sent).toMatchObject({
      ticket: 't1',
      contact: 'c1',
      requested_by: 'u1',
      issuing_side: 'Operations',
      delivery_type: 'Van',
      brand_id: 'Chick N Dip',
      restaurant_id: 'store-9',
      // Ticking the box IS the compensation decision.
      compensation: 'Compensated',
    });
    // Amount, so the percentage column stays empty — a percentage coupon can
    // never accidentally carry an amount, or the reverse.
    expect(sent.coupon_value).toBe(25);
    expect(sent.coupon_percent).toBeNull();
  });

  it('puts the number in the percentage column when the category says so', async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    await userEvent.click(screen.getByLabelText(/delivery type/i));
    await userEvent.click(await screen.findByRole('button', { name: 'All' }));
    await userEvent.click(screen.getByLabelText(/discount category/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Percentage' }));

    const pct = screen.getByLabelText(/coupon percentage/i);
    await userEvent.clear(pct);
    await userEvent.type(pct, '10');
    await waitFor(() => expect((pct as HTMLInputElement).value).toBe('10'));

    await userEvent.click(screen.getByRole('button', { name: /send for approval/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const sent = mutateAsync.mock.calls[0]![0];
    expect(sent.coupon_percent).toBe(10);
    expect(sent.coupon_value).toBeNull();
  });

  it('says what is wrong when the dates are the wrong way round', async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    await userEvent.click(screen.getByLabelText(/delivery type/i));
    await userEvent.click(await screen.findByRole('button', { name: 'All' }));
    // Sendable at this point — so what follows tests the dates and nothing else.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send for approval/i })).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2026-12-31' } });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send for approval/i })).toBeDisabled(),
    );
    // Named, not "check the highlighted fields".
    expect(screen.getByText(/end date cannot be before the start date/i)).toBeInTheDocument();
  });

  it('still works for a complaint with no order behind it', async () => {
    renderDialog({ brandId: null, restaurantId: null, customerPhone: null, description: null });
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    await userEvent.click(screen.getByLabelText(/delivery type/i));
    await userEvent.click(await screen.findByRole('button', { name: 'All' }));
    // The title is the only thing that must be filled by hand in that case.
    const title = screen.getByLabelText(/coupon title/i);
    await userEvent.type(title, 'Walk-in customer');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send for approval/i })).toBeEnabled(),
    );
  });
});

describe('the dialog inside its drawer', () => {
  it('keeps the send action with the cancel action, not loose in the body', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const footerish = within(dialog).getByRole('button', { name: /send for approval/i });
    expect(footerish).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });
});
