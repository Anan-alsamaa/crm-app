import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * ONE FIELD ANSWERS "WHO IS THIS TICKET ABOUT?" (owner, 2026-09-16).
 *
 * There used to be two: this picker for customers already in the CRM, and a
 * separate phone box for everybody else. The agent had to decide which was
 * theirs before they could file anything, and picking wrong was silent.
 *
 * What these pin is the decision the one field now makes. A number that matches
 * nobody is a customer we have not met — it must offer to record them, or the
 * walk-in is back to being a dead end. A NAME that matches nobody is simply a
 * failed search: there is no number to reach a person on, so nothing is
 * offered. Getting that line wrong in either direction is the whole bug.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string; phone?: string }) => {
      const s = o?.defaultValue ?? k;
      return o?.phone ? s.replace('{{phone}}', o.phone) : s;
    },
  }),
}));

const contacts = vi.hoisted(() => ({
  useContactSearch: vi.fn(),
  useCreateContact: vi.fn(),
}));
vi.mock('../src/features/contacts/api.js', () => contacts);

import { ContactPicker } from '../src/features/tickets/ContactPicker.js';

const createMutate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // The directory has nobody, which is the case that matters here.
  contacts.useContactSearch.mockReturnValue({ data: [], isFetching: false });
  contacts.useCreateContact.mockReturnValue({
    mutateAsync: createMutate,
    isPending: false,
    isError: false,
  });
});

const renderPicker = (props: Partial<React.ComponentProps<typeof ContactPicker>> = {}) => {
  const onChange = vi.fn();
  render(<ContactPicker value={null} onChange={onChange} vendorId="v1" {...props} />);
  return { onChange };
};

const type = (text: string) => userEvent.type(screen.getByRole('textbox'), text);

describe('ContactPicker — the customer who is not in the CRM yet', () => {
  it('offers to record a number that matches nobody', async () => {
    renderPicker();
    await type('0501234567');

    expect(await screen.findByRole('button', { name: /Add .* as a new customer/ })).toBeTruthy();
  });

  it('creates the contact and selects them, so the agent does not search again', async () => {
    const created = { id: 'new-1', name: null, phone: '0501234567', email: null, vendor: null };
    createMutate.mockResolvedValue(created);
    const { onChange } = renderPicker();
    await type('0501234567');

    await userEvent.click(screen.getByRole('button', { name: /Add .* as a new customer/ }));

    await waitFor(() =>
      // Normalised on the way in: one stored shape, or the next lookup misses.
      expect(createMutate).toHaveBeenCalledWith({ phone: '0501234567', vendor: 'v1' }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(created));
  });

  it('does NOT offer to create a customer from a name', async () => {
    renderPicker();
    await type('Ahmed');

    expect(screen.queryByRole('button', { name: /as a new customer/ })).toBeNull();
    expect(screen.getByText('No matching contacts.')).toBeTruthy();
  });

  it('does NOT offer to create one from a half-typed number', async () => {
    renderPicker();
    await type('05012');

    expect(screen.queryByRole('button', { name: /as a new customer/ })).toBeNull();
  });

  it('stays quiet while the search is still running', async () => {
    // Otherwise the button flickers under the cursor mid-type and an agent
    // creates somebody by accident.
    contacts.useContactSearch.mockReturnValue({ data: [], isFetching: true });
    renderPicker();
    await type('0501234567');

    expect(screen.queryByRole('button', { name: /as a new customer/ })).toBeNull();
  });

  it('cannot create without a vendor — the row could not carry a ticket', async () => {
    renderPicker({ vendorId: null });
    await type('0501234567');

    expect(screen.queryByRole('button', { name: /as a new customer/ })).toBeNull();
  });

  it('picks an existing customer rather than offering to create a duplicate', async () => {
    const existing = { id: 'k1', name: 'Ahmed', phone: '0501234567', email: null, vendor: null };
    contacts.useContactSearch.mockReturnValue({ data: [existing], isFetching: false });
    const { onChange } = renderPicker();
    await type('0501234567');

    expect(screen.queryByRole('button', { name: /as a new customer/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Ahmed/ }));
    expect(onChange).toHaveBeenCalledWith(existing);
  });
});
