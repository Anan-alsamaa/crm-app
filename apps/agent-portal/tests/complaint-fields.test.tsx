import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';

// t returns its defaultValue (or the key when none), matching the other suites.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

import {
  ComplaintClassification,
  ComplaintResolution,
  complaintHasErrors,
  complaintPatch,
  emptyComplaint,
  optionLabel,
  serviceTypeFromOrder,
  type ComplaintValues,
} from '../src/features/tickets/ComplaintFields.js';

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
