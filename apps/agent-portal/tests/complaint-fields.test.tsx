import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * ComplaintFields fetches the live dropdown lists via react-query now. The
 * query errors in jsdom (no Directus) and the component falls back to the code
 * enums — which is exactly the population these tests were written against.
 */
function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';

// t returns its defaultValue (or the key when none), matching the other suites.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

// The branch picker reads the operations store master. Mocked so the fieldset
// renders without a Directus client, and so the list is a known fixture.
const STORES = [
  {
    id: 's1',
    code: 'LCP-002',
    name: 'Dhahran Mall',
    city: 'Khobar',
    area_manager: 'Aly Abdullah',
    chain_manager: 'Ahmed Sami',
    yiji_restaurant_id: null,
    brand: { id: 'b1', code: 'LCP', name: 'Casa Pasta' },
  },
  {
    id: 's2',
    code: 'PSK-014',
    name: 'Doha Plaza',
    city: 'Dammam',
    area_manager: null,
    chain_manager: null,
    yiji_restaurant_id: null,
    brand: { id: 'b2', code: 'PSK', name: 'Pasketti' },
  },
];
const storeApi = vi.hoisted(() => ({
  useStores: vi.fn(),
  useStoreIndex: vi.fn(),
  useOrderStore: vi.fn(),
}));
vi.mock('../src/features/tickets/useStoreMatch.js', () => storeApi);

import {
  ComplaintClassification,
  ComplaintResolution,
  StorePicker,
  complaintHasErrors,
  complaintPatch,
  emptyComplaint,
  optionLabel,
  serviceTypeFromOrder,
  storeLabel,
  type ComplaintValues,
} from '../src/features/tickets/ComplaintFields.js';

beforeEach(() => {
  storeApi.useStores.mockReturnValue({ data: STORES, isLoading: false });
});

/** Renders the fieldset with real state so typing behaves as it does in the app. */
function Harness({ onValues }: { onValues?: (v: ComplaintValues) => void }) {
  const [values, setValues] = useState<ComplaintValues>(emptyComplaint);
  const patch = (p: Partial<ComplaintValues>) =>
    setValues((v) => {
      const next = { ...v, ...p };
      onValues?.(next);
      return next;
    });
  return (
    <>
      <ComplaintClassification values={values} onChange={patch} />
      <ComplaintResolution values={values} onChange={patch} />
    </>
  );
}

describe('complaintPatch — what actually reaches Directus', () => {
  it('sends null (not "") for every field the agent left alone', () => {
    expect(complaintPatch(emptyComplaint)).toEqual({
      complaint_date: null,
      complaint_type: null,
      service_type: null,
      complaint_source: null,
      communication_method: null,
      response_desc: null,
      compensation: null,
      coupon_code: null,
      coupon_value: null,
      coupon_percent: null,
    });
  });

  it('converts the coupon columns to numbers so compensation can be summed', () => {
    const p = complaintPatch({
      ...emptyComplaint,
      coupon_value: '25.50',
      coupon_percent: '10',
      coupon_code: '  SORRY10  ',
    });
    expect(p.coupon_value).toBe(25.5);
    expect(p.coupon_percent).toBe(10);
    // Trimmed — a trailing space would make the same coupon two coupons.
    expect(p.coupon_code).toBe('SORRY10');
  });

  it('drops an unparseable number rather than storing NaN', () => {
    const p = complaintPatch({ ...emptyComplaint, coupon_value: 'abc' });
    expect(p.coupon_value).toBeNull();
  });

  it('keeps 0 as a real value — "no coupon issued" is not the same as blank', () => {
    expect(complaintPatch({ ...emptyComplaint, coupon_value: '0' }).coupon_value).toBe(0);
  });
});

describe('complaintHasErrors', () => {
  it('accepts a blank form (every field is optional)', () => {
    expect(complaintHasErrors(emptyComplaint)).toBe(false);
  });

  it('rejects a percentage outside 0–100 and a negative amount', () => {
    expect(complaintHasErrors({ ...emptyComplaint, coupon_percent: '120' })).toBe(true);
    expect(complaintHasErrors({ ...emptyComplaint, coupon_value: '-5' })).toBe(true);
    expect(complaintHasErrors({ ...emptyComplaint, coupon_percent: '100' })).toBe(false);
  });
});

describe('optionLabel', () => {
  it('cleans up the ops team spellings for display only', () => {
    expect(optionLabel('Comp. Twiter')).toBe('X (Twitter)');
    expect(optionLabel('Dinning')).toBe('Dine-in');
  });

  it('shows anything unmapped exactly as stored', () => {
    expect(optionLabel('Missing item')).toBe('Missing item');
  });
});

describe('serviceTypeFromOrder', () => {
  const base = {
    orderId: '1',
    status: 'closed',
    total: 1,
    currency: 'SAR',
    placedAt: '',
    items: [],
  };

  it('maps the order delivery type onto their vocabulary', () => {
    expect(serviceTypeFromOrder({ ...base, deliveryType: 'delivery' })).toBe('Delivery');
    expect(serviceTypeFromOrder({ ...base, deliveryType: 'drive_thru' })).toBe('Drive Thru');
    expect(serviceTypeFromOrder({ ...base, deliveryType: 'dine_in' })).toBe('Dinning');
  });

  it('returns blank for an order with no or unknown delivery type', () => {
    expect(serviceTypeFromOrder(null)).toBe('');
    expect(serviceTypeFromOrder({ ...base, deliveryType: 'teleport' })).toBe('');
  });
});

describe('the option comboboxes are locked to the list', () => {
  it('filters as the agent types and commits the option they pick', async () => {
    const user = userEvent.setup();
    let latest: ComplaintValues = emptyComplaint;
    render(<Harness onValues={(v) => (latest = v)} />);

    const box = screen.getByLabelText('Complaint type');
    await user.click(box);
    await user.type(box, 'roach');

    // Only the matching option survives the filter.
    const option = screen.getByRole('option', { name: 'Roach found' });
    expect(screen.queryByRole('option', { name: 'Accuracy' })).toBeNull();

    await user.click(option);
    expect(latest.complaint_type).toBe('Roach found');
  });

  it('matches on the DISPLAY label too, so "whatsapp" finds "Comp. WhatsApp"', async () => {
    const user = userEvent.setup();
    let latest: ComplaintValues = emptyComplaint;
    render(<Harness onValues={(v) => (latest = v)} />);

    const box = screen.getByLabelText('Complaint source');
    await user.click(box);
    await user.type(box, 'whatsapp');
    await user.click(screen.getByRole('option', { name: 'WhatsApp' }));

    // Stored as THEIR spelling, even though the agent typed the clean one.
    expect(latest.complaint_source).toBe('Comp. WhatsApp');
  });

  it('never keeps free text — typing a value that is not on the list stores nothing', async () => {
    const user = userEvent.setup();
    let latest: ComplaintValues = emptyComplaint;
    render(<Harness onValues={(v) => (latest = v)} />);

    const box = screen.getByLabelText('Complaint type');
    await user.click(box);
    await user.type(box, 'Something I invented');
    expect(screen.getByText('No matching option.')).toBeTruthy();

    // Click away: the typing is abandoned rather than committed.
    await user.click(document.body);
    expect(latest.complaint_type).toBe('');
  });

  it('flags a coupon percentage over 100 instead of storing it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText('Coupon %'), '150');
    expect(screen.getByText('Enter a percentage between 0 and 100.')).toBeTruthy();
  });
});

describe('StorePicker — his locked restaurant field, over our store master', () => {
  function BranchHarness({ onPick }: { onPick?: (id: string) => void }) {
    const [id, setId] = useState('');
    return (
      <StorePicker
        value={id}
        onChange={(v) => {
          setId(v);
          onPick?.(v);
        }}
      />
    );
  }

  it('stores the branch ID, not its name — the name is master data that can change', async () => {
    const user = userEvent.setup();
    let picked: string | null = null;
    render(<BranchHarness onPick={(v) => (picked = v)} />);

    const box = screen.getByLabelText('Restaurant / branch');
    await user.click(box);
    await user.type(box, 'doha');
    await user.click(screen.getByRole('option', { name: /Doha Plaza/ }));

    expect(picked).toBe('s2');
  });

  it('searches on code and city as well as name, the way ops refer to a branch', async () => {
    const user = userEvent.setup();
    render(<BranchHarness />);
    const box = screen.getByLabelText('Restaurant / branch');

    await user.click(box);
    await user.type(box, 'lcp-002');
    expect(screen.getByRole('option', { name: /Dhahran Mall/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Doha Plaza/ })).toBeNull();

    await user.clear(box);
    await user.type(box, 'dammam');
    expect(screen.getByRole('option', { name: /Doha Plaza/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Dhahran Mall/ })).toBeNull();
  });

  it("fills in the branch's city and managers once chosen, as his auto-fill does", async () => {
    const user = userEvent.setup();
    render(<BranchHarness />);
    const box = screen.getByLabelText('Restaurant / branch');
    await user.click(box);
    await user.type(box, 'dhahran');
    await user.click(screen.getByRole('option', { name: /Dhahran Mall/ }));

    expect(screen.getByText(/LCP · Khobar · Area: Aly Abdullah · Chain: Ahmed Sami/)).toBeTruthy();
  });

  it('tells the agent to ask an admin rather than letting them invent a branch', async () => {
    const user = userEvent.setup();
    render(<BranchHarness />);
    const box = screen.getByLabelText('Restaurant / branch');
    await user.click(box);
    await user.type(box, 'a branch that does not exist');

    expect(screen.getByText('No branch matches. Ask an admin to add it.')).toBeTruthy();
    await user.click(document.body);
    expect((box as HTMLInputElement).value).toBe('');
  });

  it('degrades to a clear message when the store list cannot be read', async () => {
    storeApi.useStores.mockReturnValue({ data: [], isLoading: false });
    const user = userEvent.setup();
    render(<BranchHarness />);
    await user.click(screen.getByLabelText('Restaurant / branch'));
    expect(screen.getByText('Branch list unavailable.')).toBeTruthy();
  });

  it('labels a branch the way operations say it out loud', () => {
    expect(storeLabel(STORES[0]!)).toBe('LCP-002 Dhahran Mall');
  });
});
