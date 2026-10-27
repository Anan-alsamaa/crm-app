import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * EDIT AN APPROVED COUPON from its ticket (owner, 2026-10-27).
 *
 * Offered only to `edit_approved_coupons`, only on an approval that can still
 * be edited, and only where the replacement fields were read. Saving creates
 * the replacement with the editor's token, hands the pair to the gateway, and
 * waits on the two ROWS - never on Yiji. A failed hand-off abandons the
 * replacement so nothing half-made counts.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(val));
        }
      }
      return s;
    },
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

const sdk = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: sdk.request } }));
vi.mock('@directus/sdk', () => ({
  createItem: (collection: string, data: unknown) => ({ kind: 'create', collection, data }),
  readItems: (collection: string, query: unknown) => ({ kind: 'read', collection, query }),
  updateItem: (collection: string, id: string, data: unknown) => ({
    kind: 'update',
    collection,
    id,
    data,
  }),
  updateItems: () => ({ kind: 'updates' }),
}));
const producer = vi.hoisted(() => ({ replaceCoupon: vi.fn(), removeCoupon: vi.fn() }));
vi.mock('../src/lib/job-producer.js', () => ({ jobProducer: producer }));

import { useReplaceTicketCoupon, type CouponRequestRow } from '../src/features/coupons/api.js';
import {
  canOfferCouponEdit,
  CouponReplacementPill,
  draftToTerms,
} from '../src/features/tickets/EditApprovedCoupon.js';

/** The Directus query shape these mocks inspect. */
type SdkQuery = { filter?: { id?: { _in?: string[] } } & Record<string, unknown> } & Record<
  string,
  unknown
>;

const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const COUPON = {
  id: 'old-1',
  coupon_code: 'OPS-OLD11111',
  coupon_value: 25,
  coupon_percent: null,
  compensation: 'Compensated',
  reason: 'Missing items',
  status: 'assigned',
  title: '0501234567',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  valid_from: '2026-10-01',
  valid_to: future,
  max_discount: 25,
  usage_limit: 1,
  item_name: null,
  item_sku: null,
  no_other_discounts: false,
  edited_by_admin: false,
  decided_at: null,
  decision_note: null,
  date_created: null,
  ticket: { id: 't1', subject: 's', order_id: null },
  order_id: null,
  customer_phone: null,
  contact: { id: 'k1', name: 'S', phone: '0501234567' },
  requested_by: { id: 'agent-1', first_name: 'A', email: null },
  decided_by: null,
  removal_status: null,
  replaces: null,
  replaced_by: null,
  vendor: 'v1',
} as unknown as CouponRequestRow;

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  sdk.request.mockReset();
  producer.replaceCoupon.mockReset();
});

describe('who sees "Edit coupon"', () => {
  it('a holder, on an approval that can still be edited', () => {
    expect(canOfferCouponEdit(COUPON, true)).toBe(true);
    expect(canOfferCouponEdit({ ...COUPON, status: 'approved' } as CouponRequestRow, true)).toBe(
      true,
    );
  });
  it('nobody else', () => {
    expect(canOfferCouponEdit(COUPON, false)).toBe(false);
  });
  it('not on a pending / rejected / removed / used / replaced coupon', () => {
    for (const over of [
      { status: 'pending' },
      { status: 'rejected' },
      { removal_status: 'removed' },
      { removal_status: 'used' },
      { removal_status: 'pending' },
      { replaced_by: { id: 'n', coupon_code: 'X' } },
    ]) {
      expect(canOfferCouponEdit({ ...COUPON, ...over } as CouponRequestRow, true)).toBe(false);
    }
  });
  it('not where the replacement fields could not be read (not applied yet)', () => {
    const { replaces: _r, ...withoutFields } = COUPON;
    expect(canOfferCouponEdit(withoutFields as CouponRequestRow, true)).toBe(false);
  });
});

describe('the edited draft as replacement terms', () => {
  it('one money column, and an amount is its own ceiling', () => {
    const terms = draftToTerms({
      title: 't',
      code: 'X-1234',
      issuing_side: 'Operations',
      delivery_type: 'All',
      coupon_type: 'Private',
      discount_category: 'Amount',
      valid_from: '2026-10-27',
      valid_to: '2026-11-27',
      coupon_value: 40,
      coupon_percent: 10,
      max_discount: 99,
      usage_limit: 1,
      compensation_reason: 'why',
      no_other_discounts: false,
      delivery_excluded: false,
    });
    expect(terms).toMatchObject({
      coupon_value: 40,
      coupon_percent: null,
      max_discount: 40,
      reason: 'why',
    });
  });
});

describe('the pills', () => {
  it('say which side of an edit a coupon is', () => {
    const { rerender } = render(
      <CouponReplacementPill
        c={{ ...COUPON, replaced_by: { id: 'n', coupon_code: 'OPS-NEW' } } as CouponRequestRow}
      />,
    );
    expect(screen.getByText('Replaced by OPS-NEW')).toBeInTheDocument();
    rerender(
      <CouponReplacementPill
        c={
          {
            ...COUPON,
            status: 'approved',
            replaces: { id: 'o', coupon_code: 'OPS-OLD' },
          } as CouponRequestRow
        }
      />,
    );
    expect(screen.getByText('Replaces OPS-OLD')).toBeInTheDocument();
    rerender(
      <CouponReplacementPill
        c={
          {
            ...COUPON,
            status: 'rejected',
            replaces: { id: 'o', coupon_code: 'OPS-OLD' },
          } as CouponRequestRow
        }
      />,
    );
    expect(screen.getByText('Edit of OPS-OLD not applied')).toBeInTheDocument();
  });
});

const TERMS = {
  title: '0501234567',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  valid_from: '2026-10-27',
  valid_to: future,
  coupon_value: 40,
  coupon_percent: null,
  max_discount: 40,
  usage_limit: 1,
  reason: 'Missing items',
};

describe('saving an edit', () => {
  it('creates the replacement, hands it over, and reads the outcome from the two rows', async () => {
    let created: Record<string, unknown> | null = null;
    sdk.request.mockImplementation(
      async (r: {
        kind: string;
        collection: string;
        data?: Record<string, unknown>;
        query?: SdkQuery;
      }) => {
        if (r.kind === 'create') {
          created = r.data!;
          return {};
        }
        if (r.kind === 'read' && r.query?.filter?.coupon_code) return []; // code is free
        if (r.kind === 'read' && r.query?.filter?.id?._in) {
          const newId = String(created!.id);
          return [
            { id: 'old-1', status: 'assigned', replaced_by: newId, removal_status: 'removed' },
            { id: newId, status: 'approved', decision_note: null },
          ];
        }
        throw new Error(`unexpected ${r.kind} ${r.collection}`);
      },
    );
    producer.replaceCoupon.mockResolvedValue({ ok: true, jobId: '9' });
    const { result } = renderHook(() => useReplaceTicketCoupon(), { wrapper: wrapper() });

    const out = await result.current.mutateAsync({
      old: COUPON,
      terms: TERMS,
      reason: 'Wrong amount',
      editorId: 'sup-1',
    });

    expect(out.state).toBe('done');
    expect(out.code).toMatch(/^OPS-/);
    expect(created).toMatchObject({
      status: 'approved',
      replaces: 'old-1',
      decided_by: 'sup-1',
      ticket: 't1',
      requested_by: 'agent-1',
      coupon_value: 40,
    });
    expect(producer.replaceCoupon).toHaveBeenCalledWith({
      couponApprovalId: 'old-1',
      replacementId: created!.id,
      reason: 'Wrong amount',
    });
  });

  it('reports a refusal from the workers (e.g. the coupon was used) with its note', async () => {
    let newId = '';
    sdk.request.mockImplementation(
      async (r: { kind: string; data?: { id: string }; query?: SdkQuery }) => {
        if (r.kind === 'create') {
          newId = r.data!.id;
          return {};
        }
        if (r.query?.filter?.id?._in) {
          return [
            { id: 'old-1', status: 'assigned', replaced_by: null, removal_status: null },
            {
              id: newId,
              status: 'rejected',
              decision_note: 'Not changed: already used on order 7',
            },
          ];
        }
        return [];
      },
    );
    producer.replaceCoupon.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useReplaceTicketCoupon(), { wrapper: wrapper() });
    const out = await result.current.mutateAsync({
      old: COUPON,
      terms: TERMS,
      reason: 'x',
      editorId: 'sup-1',
    });
    expect(out).toMatchObject({ state: 'refused', note: 'Not changed: already used on order 7' });
  });

  it('a refused hand-off (no privilege, no Redis) abandons the replacement at once', async () => {
    const writes: Array<{ kind: string; id?: string; data?: Record<string, unknown> }> = [];
    sdk.request.mockImplementation(
      async (r: { kind: string; id?: string; data?: Record<string, unknown> }) => {
        writes.push(r);
        return r.kind === 'read' ? [] : {};
      },
    );
    producer.replaceCoupon.mockRejectedValue(
      new Error('your role does not include edit_approved_coupons'),
    );
    const { result } = renderHook(() => useReplaceTicketCoupon(), { wrapper: wrapper() });
    await expect(
      result.current.mutateAsync({ old: COUPON, terms: TERMS, reason: 'x', editorId: 'u' }),
    ).rejects.toThrow(/original coupon was kept/);
    const created = writes.find((w) => w.kind === 'create')!;
    const abandon = writes.find((w) => w.kind === 'update')!;
    expect(abandon.id).toBe(created.data?.id);
    expect(abandon.data).toMatchObject({ status: 'rejected' });
  });
});
