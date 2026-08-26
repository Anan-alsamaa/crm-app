import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CouponRequestDialog } from '../src/features/coupons/CouponRequestDialog.js';

const mutateAsync = vi.fn();

/** The one code the mocked lookup reports as already issued. */
const { TAKEN_CODE } = vi.hoisted(() => ({ TAKEN_CODE: 'OPS-TAKEN01' }));

vi.mock('../src/features/coupons/api.js', () => ({
  useRequestCouponApproval: () => ({ mutateAsync, isPending: false }),
  // Every code is free except the one the duplicate test types.
  useCouponCodeTaken: (code: string) => ({ data: code === TAKEN_CODE }),
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

  it('carries the ticket over as the reason rather than asking again', () => {
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
    // The coupon belongs to the branch the ticket was about. Offering a
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
    // "All" is selected by default now — clicking it would turn it off.
    await userEvent.click(screen.getByLabelText(/discount category/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Percentage' }));

    const pct = screen.getByLabelText(/coupon percentage/i);
    await userEvent.clear(pct);
    await userEvent.type(pct, '10');
    await waitFor(() => expect((pct as HTMLInputElement).value).toBe('10'));

    // A percentage needs a ceiling: 10% of an unbounded order is an unbounded
    // payout, and the cap is the only thing bounding it.
    const cap = screen.getByLabelText(/maximum discount/i);
    await userEvent.clear(cap);
    await userEvent.type(cap, '50');
    await waitFor(() => expect((cap as HTMLInputElement).value).toBe('50'));

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
    // "All" is selected by default now — clicking it would turn it off.

    // A coupon needs an amount before it can be sent — see couponTermsProblems.
    const amount = screen.getByLabelText(/coupon value/i);
    await userEvent.clear(amount);
    await userEvent.type(amount, '25');
    // Sendable at this point — so what follows tests the dates and nothing else.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send for approval/i })).toBeEnabled(),
    );

    // dd/mm/yyyy is what the field takes now; the value it hands upstream is
    // still ISO, which is what the validation below reads.
    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '31/12/2026' } });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send for approval/i })).toBeDisabled(),
    );
    // Named, not "check the highlighted fields".
    expect(screen.getByText(/end date cannot be before the start date/i)).toBeInTheDocument();
  });

  it('starts with every delivery channel selected', async () => {
    // A compensation coupon is nearly always meant to work however the
    // customer next orders, so the common case needs no clicks at all.
    renderDialog();
    expect(screen.getByLabelText(/delivery type/i)).toHaveTextContent(/all/i);
  });

  it('keeps the issuing-side prefix when the code is regenerated', async () => {
    // The button handed back a SARA- code on an Operations coupon: the prefix
    // is how anyone reading a code down a phone knows who issued it.
    renderDialog();
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    const code = screen.getByLabelText(/coupon code/i) as HTMLInputElement;
    await waitFor(() => expect(code.value.startsWith('OPS-')).toBe(true));

    await userEvent.click(screen.getByRole('button', { name: /new code/i }));
    await waitFor(() => expect(code.value.startsWith('OPS-')).toBe(true));
  });

  it('keeps a HAND-TYPED code when the issuing side changes afterwards', async () => {
    /*
     * The regression the editable field created. The code carries the issuing
     * side as a prefix, so changing the side used to re-stamp the code — which
     * was harmless while the field was read-only and is data loss now: an agent
     * types the code a branch already printed, corrects the issuing side, and
     * watches it silently vanish with no way to get it back.
     */
    renderDialog();
    // One commit — see the duplicate-code test for why typing races on CI.
    const code = screen.getByLabelText(/coupon code/i) as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'BRANCH-PRINTED-42' } });

    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));

    expect(code.value).toBe('BRANCH-PRINTED-42');
  });

  it('hands the field back to the generator once New code is pressed', async () => {
    // Asking for a generated code is asking to stop hand-editing, so the
    // issuing side may re-stamp it again after that.
    renderDialog();
    const code = screen.getByLabelText(/coupon code/i) as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'MINE-1' } });

    await userEvent.click(screen.getByRole('button', { name: /new code/i }));
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));

    await waitFor(() => expect(code.value.startsWith('OPS-')).toBe(true));
  });

  it('warns before sending that a coupon over SAR 200 alerts an admin', async () => {
    /*
     * The alert itself fires server-side — the row is written straight to
     * Directus from the browser, so the dialog can never be the enforcement
     * point. This is only so the agent is not surprised to hear an admin was
     * paged about their coupon. It must NOT block: large compensations are
     * legitimate, they are just watched.
     */
    renderDialog();
    expect(screen.queryByText(/an admin is alerted/i)).toBeNull();

    // One commit — a partially-typed "5" is below the threshold and the notice
    // would not be showing yet.
    fireEvent.change(screen.getByLabelText(/coupon value/i), { target: { value: '500' } });

    expect(await screen.findByText(/an admin is alerted/i)).toBeInTheDocument();
    /*
     * And it is a NOTICE, not a gate. Asserted by the absence of a blocking
     * message rather than on the button, which a fresh draft leaves disabled
     * for unrelated reasons (the dropdowns operations owns are still empty).
     */
    expect(screen.queryByText(/maximum discount is below|worth 0|worth nothing/i)).toBeNull();
  });

  it('will not send a coupon worth nothing, and says which field is wrong', async () => {
    // One was approved worth 0 SAR because the form let it through. The amount
    // now has to be present and positive before the request can leave.
    renderDialog();
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    // "All" is selected by default now — clicking it would turn it off.

    const amount = screen.getByLabelText(/coupon value/i);
    await userEvent.clear(amount);
    await userEvent.type(amount, '0');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send for approval/i })).toBeDisabled(),
    );
    expect(screen.getByText(/coupon worth 0 is not a coupon/i)).toBeInTheDocument();
  });

  it('shows the ceiling always, but only lets a PERCENTAGE set it', async () => {
    /*
     * Both halves matter. Hiding it entirely was the wrong answer — the cap is
     * what the supervisor approves against, so a coupon showing none reads as
     * uncapped. But letting a flat amount carry its own separate cap is how 568
     * came to be approved with a ceiling of 55, and one of those two numbers
     * was a lie to the customer.
     */
    renderDialog();
    const cap = screen.getByLabelText(/maximum discount/i);
    expect(cap).toBeInTheDocument();
    expect(cap).toHaveAttribute('readonly');

    await userEvent.click(screen.getByLabelText(/discount category/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Percentage' }));
    expect(screen.getByLabelText(/maximum discount/i)).not.toHaveAttribute('readonly');
  });

  it('follows the coupon value as the ceiling for a flat amount', async () => {
    // Derived, not asked — so the two can never disagree.
    renderDialog();
    // One commit, for the reason spelled out in the duplicate-code test below.
    fireEvent.change(screen.getByLabelText(/coupon value/i), { target: { value: '75' } });
    expect(screen.getByLabelText(/maximum discount/i)).toHaveValue(75);
  });

  it('refuses a coupon code another coupon already carries', async () => {
    /*
     * The code is typed now, so two coupons can be given the same one — and a
     * duplicate is not cosmetic: the push sends it to Yiji as the idempotency
     * key, so the second request reads as a RETRY of the first and the customer
     * is told about a coupon that was never created.
     */
    renderDialog();
    /*
     * `fireEvent.change`, NOT `userEvent.type`. This test failed on CI and
     * passed locally: the DOM dump showed the input holding "O" — one
     * character — because `userEvent.type` dispatches a keystroke at a time and
     * the slow runner let the assertion overtake the remaining ten. The mock
     * reports "taken" only for the exact full code, so the error had not
     * rendered yet.
     *
     * A longer timeout would only move the race. `fireEvent.change` commits the
     * whole value in a single React update, so there is no intermediate state
     * to lose to. Same reason the date fields below use it.
     */
    const code = screen.getByLabelText(/coupon code/i);
    fireEvent.change(code, { target: { value: TAKEN_CODE } });

    expect(await screen.findByText(/already in use/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send|request/i })).toBeDisabled();
  });

  it('still works for a ticket with no order behind it', async () => {
    renderDialog({ brandId: null, restaurantId: null, customerPhone: null, description: null });
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    // "All" is selected by default now — clicking it would turn it off.
    // The title is the only thing that must be filled by hand in that case.
    const title = screen.getByLabelText(/coupon title/i);
    await userEvent.type(title, 'Walk-in customer');

    // A coupon needs an amount before it can be sent — see couponTermsProblems.
    const amount = screen.getByLabelText(/coupon value/i);
    await userEvent.clear(amount);
    await userEvent.type(amount, '25');
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

describe('opening it from the add-ticket page', () => {
  it('picks up a ticket typed after the page was mounted', async () => {
    // The reported bug. On add-ticket this dialog is mounted with the page, so
    // the initial state was captured while the description was still empty and
    // the agent was asked to type the ticket a second time.
    const { rerender } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CouponRequestDialog
          open={false}
          onClose={() => {}}
          ticketId=""
          contactId="c1"
          customerPhone={null}
          description={null}
          brandId={null}
          restaurantId={null}
          requestedBy="u1"
          onCollect={() => {}}
        />
      </QueryClientProvider>,
    );
    // The agent fills the ticket in, then ticks the coupon box.
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CouponRequestDialog
          open
          onClose={() => {}}
          ticketId=""
          contactId="c1"
          customerPhone="+966501112233"
          description="Driver left the order at the wrong gate."
          brandId="Chick N Dip"
          restaurantId="store-4"
          requestedBy="u1"
          onCollect={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByDisplayValue('Driver left the order at the wrong gate.'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('+966501112233')).toBeInTheDocument();
  });
});

/**
 * The Item field names the order line the coupon is about — the missing or
 * wrong one. Where the ticket came from decides how it is answered: from the
 * inbox the order is known, so the agent CHOOSES a real line; raised manually
 * there is no order to choose from, so they type what the customer said.
 * Optional either way — not every ticket is about one item.
 */
describe('the item a coupon compensates', () => {
  it('offers the order lines to choose from when the ticket came from an order', async () => {
    renderDialog({
      orderItems: [
        { name: 'Vegetable Pasta', price: 26 },
        { name: 'Garlic Bread', price: 26 },
      ],
    });
    await userEvent.click(screen.getByLabelText(/item/i));
    expect(await screen.findByRole('button', { name: /Vegetable Pasta/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Garlic Bread/ })).toBeInTheDocument();
    // Optional: an explicit way to say the coupon is not about one line.
    expect(screen.getByRole('button', { name: /not about one item/i })).toBeInTheDocument();
  });

  it('fills the coupon with what the chosen item cost, still editable', async () => {
    renderDialog({ orderItems: [{ name: 'Vegetable Pasta', price: 26 }] });
    await userEvent.click(screen.getByLabelText(/item/i));
    await userEvent.click(await screen.findByRole('button', { name: /Vegetable Pasta/ }));

    const amount = screen.getByLabelText(/coupon value/i) as HTMLInputElement;
    await waitFor(() => expect(amount.value).toBe('26'));

    // A starting point, not the answer — the agent can still change it.
    await userEvent.clear(amount);
    await userEvent.type(amount, '15');
    await waitFor(() => expect(amount.value).toBe('15'));
  });

  it('records the item ID beside the name when the item was PICKED', async () => {
    /*
     * The name is the label; the id is the key. Grouping by name cannot answer
     * "which customers complained about the pasta" — this database already
     * holds `Vegetable Pasta.yy` in an `item_name`, one typo that is now
     * permanently its own distinct value.
     */
    renderDialog({ orderItems: [{ name: 'Vegetable Pasta', price: 26, sku: '1047' }] });
    await userEvent.click(screen.getByLabelText(/item/i));
    await userEvent.click(await screen.findByRole('button', { name: /Vegetable Pasta/ }));

    // The dropdowns operations owns, plus a value — the same minimum the
    // "sends the branch it resolved" test above establishes.
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    await userEvent.click(screen.getByLabelText(/delivery type/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Van' }));
    await userEvent.click(screen.getByRole('button', { name: /send for approval/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    /* The LAST call, not the first. The spy is shared across this file and an
       earlier test in the same run may already have sent one — reading
       `calls[0]` then asserts against somebody else's payload. */
    const sent = mutateAsync.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(sent.item_name).toBe('Vegetable Pasta');
    expect(sent.item_sku).toBe('1047');
  });

  it('clears the id when the agent says it is NOT about one item', async () => {
    // Otherwise a stale sku outlives the name it belonged to and files the
    // coupon under an item nobody chose.
    renderDialog({ orderItems: [{ name: 'Vegetable Pasta', price: 26, sku: '1047' }] });
    const itemBox = screen.getByLabelText(/item \(optional\)/i);
    await userEvent.click(itemBox);
    await userEvent.click(await screen.findByRole('button', { name: /Vegetable Pasta/ }));
    // Reopen and choose the explicit "no single item" option.
    await userEvent.click(itemBox);
    await userEvent.click(await screen.findByRole('button', { name: /not about one item/i }));

    // The dropdowns operations owns, plus a value — the same minimum the
    // "sends the branch it resolved" test above establishes.
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    await userEvent.click(screen.getByLabelText(/delivery type/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Van' }));
    await userEvent.click(screen.getByRole('button', { name: /send for approval/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    /* The LAST call, not the first. The spy is shared across this file and an
       earlier test in the same run may already have sent one — reading
       `calls[0]` then asserts against somebody else's payload. */
    const sent = mutateAsync.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(sent.item_name).toBeNull();
    expect(sent.item_sku).toBeNull();
  });

  it('offers the same line once however many were ordered', async () => {
    // 2x the same dish is one item to compensate, not two identical choices.
    renderDialog({
      orderItems: [
        { name: 'Vegetable Pasta', price: 26 },
        { name: 'Vegetable Pasta', price: 26 },
      ],
    });
    await userEvent.click(screen.getByLabelText(/item/i));
    await screen.findByRole('button', { name: /Vegetable Pasta/ });
    expect(screen.getAllByRole('button', { name: /Vegetable Pasta/ })).toHaveLength(1);
  });

  it('takes a typed item when the ticket was raised by hand', async () => {
    // No order behind it — the agent heard the item down a phone line.
    renderDialog({ orderItems: [] });
    const typed = screen.getByLabelText(/item/i);
    expect(typed.tagName).toBe('INPUT');
    /*
     * One atomic change, not a per-character `userEvent.type`.
     *
     * This field is controlled, so every keystroke round-trips through React
     * state; on a loaded CI runner the typing outran the re-renders and the
     * input landed on "Ch". The race was in the test, not the component —
     * a human types slower than React commits — but a test that only passes on
     * a fast machine reports a failure that says nothing about the code, which
     * is exactly the noise that trains people to ignore CI.
     */
    fireEvent.change(typed, { target: { value: 'Chicken Shawarma' } });
    await waitFor(() => expect(typed).toHaveValue('Chicken Shawarma'));
  });

  it('sends the chosen line with the request', async () => {
    const onCollect = vi.fn();
    renderDialog({ orderItems: [{ name: 'Vegetable Pasta', price: 26 }], onCollect });
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    await userEvent.click(screen.getByLabelText(/delivery type/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Van' }));
    await userEvent.click(screen.getByLabelText(/item/i));
    await userEvent.click(await screen.findByRole('button', { name: /Vegetable Pasta/ }));

    // A coupon needs an amount before it can be sent — see couponTermsProblems.
    const amount = screen.getByLabelText(/coupon value/i);
    await userEvent.clear(amount);
    await userEvent.type(amount, '25');

    await userEvent.click(screen.getByRole('button', { name: /attach to this ticket/i }));
    await waitFor(() => expect(onCollect).toHaveBeenCalled());
    expect(onCollect.mock.calls[0]![0]).toMatchObject({ item_name: 'Vegetable Pasta' });
  });

  it('leaves the item null when the ticket is not about one', async () => {
    const onCollect = vi.fn();
    renderDialog({ orderItems: [{ name: 'Vegetable Pasta', price: 26 }], onCollect });
    await userEvent.click(screen.getByLabelText(/issuing side/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Operations' }));
    await userEvent.click(screen.getByLabelText(/delivery type/i));
    await userEvent.click(await screen.findByRole('button', { name: 'Van' }));

    // A coupon needs an amount before it can be sent — see couponTermsProblems.
    const amount = screen.getByLabelText(/coupon value/i);
    await userEvent.clear(amount);
    await userEvent.type(amount, '25');

    await userEvent.click(screen.getByRole('button', { name: /attach to this ticket/i }));
    await waitFor(() => expect(onCollect).toHaveBeenCalled());
    // Not the empty string: "no item" is an absence, and the column is nullable.
    expect(onCollect.mock.calls[0]![0]!.item_name ?? null).toBeNull();
  });
});
