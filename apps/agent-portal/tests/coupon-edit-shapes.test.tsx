import { describe, it, expect, vi } from 'vitest';
/* Run with coupons OUT of maintenance (see coupon-request-dialog.test.tsx). */
vi.mock('../src/features/coupons/maintenance.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/coupons/maintenance.js')>()),
  useCouponsUnderMaintenance: () => false,
  useCouponsMaintenanceState: () => ({ paused: false, known: true }),
  assertCouponsOpen: async () => {},
}));
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  couponTermsChanges,
  defaultCouponDates,
  type CouponRequestDraft,
} from '@yiji/shared-types';
import { CouponRequestDialog } from '../src/features/coupons/CouponRequestDialog.js';
import { editDialogProps, NOTHING_CHANGED } from '../src/features/tickets/EditApprovedCoupon.js';
import type { CouponRequestRow } from '../src/features/coupons/api.js';

/**
 * THE EDIT FORM, FOR EVERY STORED SHAPE (owner, 2026-11-12).
 *
 * Rows are written the way Directus returns them: DECIMAL columns as TEXT
 * ("38.00000"), coupon_value as a number. For each one the form must open on
 * the stored values, refuse a Save that changes nothing, and accept a Save
 * that changes one value - sending only that change (plus the total limit
 * where the rule moves it).
 */

vi.mock('../src/features/coupons/group-order-check.js', () => ({
  useGroupOrderCheck: () => ({ data: null }),
}));
vi.mock('../src/features/coupons/api.js', () => ({
  useRequestCouponApproval: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
        coupon_type: ['Private', 'General'],
        discount_category: ['Amount', 'Percentage'],
      },
    }),
  };
});

const REASON_LABEL = 'Why is this approved coupon being changed?';
const FUTURE_TO = '2099-12-31';

const BASE = {
  id: 'ca-1',
  coupon_code: 'OPS-SHAPE111',
  compensation: 'Compensated',
  reason: 'Missing items',
  status: 'assigned',
  title: '0501234567',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  valid_from: '2026-11-01T00:00:00',
  valid_to: `${FUTURE_TO}T00:00:00`,
  coupon_value: 38,
  coupon_percent: null,
  max_discount: '38.00000',
  usage_limit: 1,
  total_discount_limit: '38.00000',
  item_name: null,
  item_sku: null,
  no_other_discounts: false,
  delivery_excluded: false,
  delivery_excluded_reason: null,
  contact: { id: 'k1', name: 'S', phone: '0501234567' },
  requested_by: { id: 'agent-1', first_name: 'A', email: null },
  removal_status: null,
  replaces: null,
  replaced_by: null,
};
const row = (over: Record<string, unknown>) =>
  ({ ...BASE, ...over }) as unknown as CouponRequestRow;

function renderEdit(c: CouponRequestRow) {
  const props = editDialogProps(c);
  const onSave = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CouponRequestDialog
        open
        onClose={() => {}}
        editingId={c.id}
        replaceOf={{ code: c.coupon_code, expiredOn: null }}
        contactId="k1"
        customerPhone="0501234567"
        description={c.reason ?? null}
        brandId={null}
        restaurantId={null}
        requestedBy="agent-1"
        initial={props.initial}
        editBlock={props.editBlock}
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  return { props, onSave, save: screen.getByRole('button', { name: 'Save changes' }) };
}

const valueOf = (label: RegExp) => (screen.getByLabelText(label) as HTMLInputElement).value;
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function giveReason() {
  fireEvent.change(screen.getByLabelText(REASON_LABEL), {
    target: { value: 'Customer called back' },
  });
}
function ackGeneral() {
  fireEvent.click(within(screen.getByTestId('coupon-general-ack')).getByRole('checkbox'));
}
async function expectNothingChanged(save: HTMLElement) {
  await waitFor(() => expect(screen.getByText(NOTHING_CHANGED)).toBeInTheDocument());
  expect(save).toBeDisabled();
}
async function saveAndGetDraft(save: HTMLElement, onSave: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(save).toBeEnabled(), { timeout: 10_000 });
  expect(screen.queryByText(NOTHING_CHANGED)).toBeNull();
  fireEvent.click(save);
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  return onSave.mock.calls[0]![0] as CouponRequestDraft;
}

const T = 30_000;

describe('editing every stored coupon shape', () => {
  it(
    '(a) Private/Amount 38, limit "38.00000", item set',
    async () => {
      const c = row({ item_name: 'Chicken box', item_sku: 'SKU-1' });
      const { props, onSave, save } = renderEdit(c);
      expect(valueOf(/coupon value/i)).toBe('38');
      expect(valueOf(/maximum discount/i)).toBe('38');
      expect(valueOf(/number of uses/i)).toBe('1');
      giveReason();
      await expectNothingChanged(save);
      fireEvent.change(screen.getByLabelText(/coupon value/i), { target: { value: '40' } });
      const terms = props.toTerms(await saveAndGetDraft(save, onSave));
      expect(terms).toMatchObject({
        coupon_value: 40,
        max_discount: 40,
        total_discount_limit: 40,
        usage_limit: 1,
        item_name: 'Chicken box',
        item_sku: 'SKU-1',
        coupon_type: 'Private',
      });
      expect(couponTermsChanges(c as never, terms as never)).toEqual([
        'coupon_value',
        'max_discount',
        'total_discount_limit',
      ]);
    },
    T,
  );

  it(
    '(b) Private/Amount 3, max "3.00000", no stored limit (older coupon)',
    async () => {
      const c = row({ coupon_value: 3, max_discount: '3.00000', total_discount_limit: null });
      const { props, onSave, save } = renderEdit(c);
      expect(valueOf(/coupon value/i)).toBe('3');
      expect(valueOf(/maximum discount/i)).toBe('3');
      giveReason();
      await expectNothingChanged(save);
      fireEvent.change(screen.getByLabelText(/coupon value/i), { target: { value: '5' } });
      const terms = props.toTerms(await saveAndGetDraft(save, onSave));
      expect(terms).toMatchObject({ coupon_value: 5, max_discount: 5, total_discount_limit: 5 });
      expect(couponTermsChanges(c as never, terms as never)).toEqual([
        'coupon_value',
        'max_discount',
        'total_discount_limit',
      ]);
    },
    T,
  );

  const raised = () =>
    row({
      coupon_value: 10,
      max_discount: '10.00000',
      total_discount_limit: '76.00000',
      no_other_discounts: true,
    });

  it(
    '(c) Private/Amount 10 with an admin-raised limit of 76',
    async () => {
      const c = raised();
      const { props, onSave, save } = renderEdit(c);
      expect(valueOf(/coupon value/i)).toBe('10');
      expect(valueOf(/maximum discount/i)).toBe('10');
      const noOther = screen.getByRole('checkbox', {
        name: /cannot be used with other discounts/i,
      });
      expect((noOther as HTMLInputElement).checked).toBe(true);
      giveReason();
      await expectNothingChanged(save);
      fireEvent.change(screen.getByLabelText(/coupon value/i), { target: { value: '12' } });
      const terms = props.toTerms(await saveAndGetDraft(save, onSave));
      expect(terms).toMatchObject({
        coupon_value: 12,
        max_discount: 12,
        total_discount_limit: 12,
        no_other_discounts: true,
      });
      expect(couponTermsChanges(c as never, terms as never)).toEqual([
        'coupon_value',
        'max_discount',
        'total_discount_limit',
      ]);
    },
    T,
  );

  it(
    '(c) changing only the end date keeps the admin limit of 76',
    async () => {
      const c = raised();
      const { props, onSave, save } = renderEdit(c);
      giveReason();
      await expectNothingChanged(save);
      fireEvent.change(screen.getByDisplayValue(dmy(FUTURE_TO)), {
        target: { value: '30/06/2099' },
      });
      const terms = props.toTerms(await saveAndGetDraft(save, onSave));
      expect(terms).toMatchObject({
        valid_to: '2099-06-30',
        coupon_value: 10,
        total_discount_limit: 76,
      });
      expect(couponTermsChanges(c as never, terms as never)).toEqual(['valid_to']);
    },
    T,
  );

  it(
    '(d) Private/Percentage 10% capped at "1.00000"',
    async () => {
      const c = row({
        discount_category: 'Percentage',
        coupon_value: null,
        coupon_percent: '10.00000',
        max_discount: '1.00000',
        total_discount_limit: '1.00000',
      });
      const { props, onSave, save } = renderEdit(c);
      expect(valueOf(/coupon percentage/i)).toBe('10');
      expect(valueOf(/maximum discount/i)).toBe('1');
      expect(valueOf(/number of uses/i)).toBe('1');
      giveReason();
      await expectNothingChanged(save);
      fireEvent.change(screen.getByLabelText(/coupon percentage/i), { target: { value: '20' } });
      const terms = props.toTerms(await saveAndGetDraft(save, onSave));
      expect(terms).toMatchObject({
        coupon_value: null,
        coupon_percent: 20,
        max_discount: 1,
        total_discount_limit: 1,
      });
      expect(couponTermsChanges(c as never, terms as never)).toEqual(['coupon_percent']);
    },
    T,
  );

  it(
    '(e) General/Amount 5 with a limit of 500 (warning confirmed first)',
    async () => {
      const c = row({
        coupon_type: 'General',
        coupon_value: 5,
        max_discount: '5.00000',
        total_discount_limit: '500.00000',
      });
      const { props, onSave, save } = renderEdit(c);
      expect(valueOf(/coupon value/i)).toBe('5');
      expect((screen.getByTestId('coupon-total-limit') as HTMLInputElement).value).toBe('500');
      ackGeneral();
      giveReason();
      await expectNothingChanged(save);
      fireEvent.change(screen.getByLabelText(/coupon value/i), { target: { value: '6' } });
      const terms = props.toTerms(await saveAndGetDraft(save, onSave));
      expect(terms).toMatchObject({
        coupon_type: 'General',
        coupon_value: 6,
        max_discount: 6,
        total_discount_limit: 500,
      });
      expect(couponTermsChanges(c as never, terms as never)).toEqual([
        'coupon_value',
        'max_discount',
      ]);
    },
    T,
  );

  it(
    '(f) an EXPIRED coupon opens on fresh valid dates and still saves',
    async () => {
      const c = row({
        coupon_value: 20,
        max_discount: '20.00000',
        total_discount_limit: '20.00000',
        valid_from: '2026-09-01T00:00:00',
        valid_to: '2026-10-01T00:00:00',
      });
      const fresh = defaultCouponDates(new Date());
      const { props, onSave, save } = renderEdit(c);
      expect(props.initial).toMatchObject(fresh);
      expect(screen.getByDisplayValue(dmy(fresh.valid_from))).toBeInTheDocument();
      expect(screen.getByDisplayValue(dmy(fresh.valid_to))).toBeInTheDocument();
      expect(valueOf(/coupon value/i)).toBe('20');
      giveReason();
      /* The fresh dates ARE a change: renewing an expired coupon is a valid edit. */
      await waitFor(() => expect(save).toBeEnabled(), { timeout: 10_000 });
      fireEvent.change(screen.getByLabelText(/coupon value/i), { target: { value: '25' } });
      const terms = props.toTerms(await saveAndGetDraft(save, onSave));
      expect(terms).toMatchObject({
        ...fresh,
        coupon_value: 25,
        max_discount: 25,
        total_discount_limit: 25,
      });
      expect(couponTermsChanges(c as never, terms as never)).toEqual([
        'coupon_value',
        'max_discount',
        'valid_from',
        'valid_to',
        'total_discount_limit',
      ]);
    },
    T,
  );
});
