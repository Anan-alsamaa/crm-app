import { describe, expect, it, vi } from 'vitest';
import {
  buildReplacementCoupon,
  couponEditBlock,
  couponIsExpired,
  couponIsSuperseded,
  couponReplacedHistoryText,
  couponReplaceState,
  CouponReplaceJob,
  CouponReplaceNotStarted,
  effectivePrivileges,
  refId,
  replacementReleased,
  replacementTermsProblem,
  startCouponReplacement,
  waitForCouponReplacement,
  type CouponReplaceIO,
  type CouponReplacementTerms,
} from '../src/index.js';

/**
 * EDIT AN APPROVED COUPON = REPLACE IT (owner, 2026-10-27). Pure rules: who
 * may, what can be edited, what is left out of totals, and the portal's
 * start/abandon/wait flow with every I/O mocked - nothing here talks to
 * Directus or Yiji.
 */

const TODAY = new Date('2026-10-27T10:00:00Z');

const TERMS: CouponReplacementTerms = {
  title: '0501234567',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  valid_from: '2026-10-27',
  valid_to: '2026-11-27',
  coupon_value: 40,
  coupon_percent: null,
  max_discount: 40,
  usage_limit: 1,
  item_name: 'Burger',
  reason: 'Cold food',
};

const OLD = {
  id: 'old-1',
  coupon_code: 'OPS-OLD12345',
  ticket: { id: 't1' },
  contact: { id: 'c1' },
  requested_by: { id: 'agent-1' },
  vendor: 'v1',
  customer_phone: null,
  order_id: null,
  brand_id: 'b',
  restaurant_id: 'r',
  compensation: 'Compensated',
  delivery_excluded: false,
  delivery_excluded_reason: null,
};

describe('edit_approved_coupons - WeCare Supervisor, WeCare Admin, Administrator', () => {
  it('defaults on for exactly those three roles', () => {
    expect(effectivePrivileges({}, 'WeCare Supervisor').edit_approved_coupons).toBe(true);
    expect(effectivePrivileges({}, 'WeCare Admin').edit_approved_coupons).toBe(true);
    expect(effectivePrivileges(null, 'Administrator').edit_approved_coupons).toBe(true);
    expect(
      effectivePrivileges({ approve_coupons: true }, 'WeCare Agent').edit_approved_coupons,
    ).toBe(false);
    expect(effectivePrivileges({ approve_coupons: true }, 'CEO').edit_approved_coupons).toBe(false);
  });
  it('a stored switch wins either way', () => {
    expect(
      effectivePrivileges({ edit_approved_coupons: false }, 'WeCare Supervisor')
        .edit_approved_coupons,
    ).toBe(false);
    expect(
      effectivePrivileges({ edit_approved_coupons: true }, 'WeCare Agent').edit_approved_coupons,
    ).toBe(true);
  });
});

describe('which coupons can be edited', () => {
  it('any APPROVAL - approved, amended or delivered', () => {
    for (const status of ['approved', 'edited', 'assigned']) {
      expect(couponEditBlock({ status }), status).toBeNull();
    }
  });
  it('not a pending or rejected request', () => {
    expect(couponEditBlock({ status: 'pending' })).toBe('not-approved');
    expect(couponEditBlock({ status: 'rejected' })).toBe('not-approved');
  });
  it('not one already replaced, removed, being removed, or known to be used', () => {
    expect(couponEditBlock({ status: 'assigned', replaced_by: { id: 'n' } })).toBe('replaced');
    expect(couponEditBlock({ status: 'assigned', removal_status: 'removed' })).toBe('removed');
    expect(couponEditBlock({ status: 'approved', removal_status: 'not_on_yiji' })).toBe('removed');
    expect(couponEditBlock({ status: 'assigned', removal_status: 'pending' })).toBe(
      'removal-pending',
    );
    expect(couponEditBlock({ status: 'assigned', removal_status: 'used' })).toBe('used');
  });
  it('a FAILED removal does not block an edit (it can be retried)', () => {
    expect(couponEditBlock({ status: 'assigned', removal_status: 'failed' })).toBeNull();
  });
});

describe('report de-duplication', () => {
  it('leaves out the replaced coupon and an abandoned edit, keeps the replacement', () => {
    expect(couponIsSuperseded({ status: 'assigned', replaced_by: 'new-1' })).toBe(true);
    expect(couponIsSuperseded({ status: 'rejected', replaces: 'old-1' })).toBe(true);
    expect(couponIsSuperseded({ status: 'approved', replaces: 'old-1' })).toBe(false);
    expect(couponIsSuperseded({ status: 'assigned' })).toBe(false);
    // An ordinary rejection is still a rejection.
    expect(couponIsSuperseded({ status: 'rejected' })).toBe(false);
  });
  it('reads an M2O as an id or an expanded object', () => {
    expect(refId({ id: 'x' })).toBe('x');
    expect(refId(' y ')).toBe('y');
    expect(refId(null)).toBeNull();
    expect(refId({ id: null })).toBeNull();
  });
});

describe('expiry', () => {
  it('whole days, inclusive', () => {
    expect(couponIsExpired('2026-10-27', TODAY)).toBe(false);
    expect(couponIsExpired('2026-10-26', TODAY)).toBe(true);
    expect(couponIsExpired(null, TODAY)).toBe(false);
  });
});

describe('the edited terms', () => {
  it('accepts a valid coupon', () => {
    expect(replacementTermsProblem(TERMS, TODAY)).toBeNull();
  });
  it('refuses what could never have been approved', () => {
    expect(replacementTermsProblem({ ...TERMS, coupon_value: 0 }, TODAY)).toMatch(/worth 0/);
    expect(replacementTermsProblem({ ...TERMS, valid_to: '2026-10-01' }, TODAY)).toMatch(
      /before the start/,
    );
    expect(
      replacementTermsProblem(
        { ...TERMS, valid_from: '2026-10-01', valid_to: '2026-10-20' },
        TODAY,
      ),
    ).toMatch(/already past/);
    expect(
      replacementTermsProblem(
        { ...TERMS, discount_category: 'Percentage', coupon_percent: 20, max_discount: null },
        TODAY,
      ),
    ).toMatch(/ceiling/);
    expect(replacementTermsProblem({ ...TERMS, usage_limit: 0 }, TODAY)).toMatch(/at least once/);
  });
});

describe('the replacement row', () => {
  const row = buildReplacementCoupon(OLD, TERMS, {
    id: 'new-1',
    code: 'OPS-NEW12345',
    editorId: 'sup-1',
    reason: ' Wrong amount ',
    now: TODAY,
  });
  it('is approved at once, by the editor, as an amendment that replaces the old one', () => {
    expect(row).toMatchObject({
      id: 'new-1',
      coupon_code: 'OPS-NEW12345',
      status: 'approved',
      edited_by_admin: true,
      decided_by: 'sup-1',
      replaces: 'old-1',
      replace_reason: 'Wrong amount',
    });
    expect(String(row.decision_note)).toContain('OPS-OLD12345');
  });
  it('keeps WHO and WHAT FOR from the old coupon', () => {
    expect(row).toMatchObject({
      ticket: 't1',
      contact: 'c1',
      requested_by: 'agent-1',
      vendor: 'v1',
      brand_id: 'b',
      restaurant_id: 'r',
      delivery_excluded: false,
    });
  });
  it('writes ONE money column, and an amount is its own ceiling', () => {
    expect(row).toMatchObject({ coupon_value: 40, coupon_percent: null, max_discount: 40 });
    const pct = buildReplacementCoupon(
      OLD,
      {
        ...TERMS,
        discount_category: 'Percentage',
        coupon_value: 99,
        coupon_percent: 15,
        max_discount: 30,
      },
      { id: 'n', code: 'C', editorId: null, reason: 'r', now: TODAY },
    );
    expect(pct).toMatchObject({ coupon_value: null, coupon_percent: 15, max_discount: 30 });
  });
});

describe('when the replacement may be delivered', () => {
  it('only once the old row is claimed for it AND gone from the app', () => {
    expect(replacementReleased('n', null)).toBe(false);
    expect(replacementReleased('n', { replaced_by: null, removal_status: 'removed' })).toBe(false);
    expect(replacementReleased('n', { replaced_by: 'n', removal_status: 'pending' })).toBe(false);
    expect(replacementReleased('n', { replaced_by: 'other', removal_status: 'removed' })).toBe(
      false,
    );
    expect(replacementReleased('n', { replaced_by: 'n', removal_status: 'removed' })).toBe(true);
    expect(
      replacementReleased('n', { replaced_by: { id: 'n' }, removal_status: 'not_on_yiji' }),
    ).toBe(true);
  });
  it('the portal reads done / refused / working from the two rows', () => {
    expect(couponReplaceState({ id: 'n', status: 'rejected' }, null)).toBe('refused');
    expect(
      couponReplaceState(
        { id: 'n', status: 'approved' },
        { replaced_by: 'n', removal_status: 'removed' },
      ),
    ).toBe('done');
    expect(couponReplaceState({ id: 'n', status: 'approved' }, { replaced_by: 'n' })).toBe(
      'working',
    );
  });
});

describe('the job payload', () => {
  it('needs both ids and a reason; WHO is set by the gateway', () => {
    const ok = { couponApprovalId: 'o', replacementId: 'n', editedBy: 'u', reason: 'x' };
    expect(CouponReplaceJob.safeParse(ok).success).toBe(true);
    expect(CouponReplaceJob.safeParse({ ...ok, reason: '  ' }).success).toBe(false);
    expect(
      CouponReplaceJob.omit({ editedBy: true }).safeParse({ ...ok, editedBy: undefined }).success,
    ).toBe(true);
  });
  it('the history line names both codes, who and why', () => {
    expect(
      couponReplacedHistoryText({ oldCode: 'A', newCode: 'B', editor: 'Sara', reason: ' typo ' }),
    ).toBe('Coupon A replaced by B by Sara: typo');
  });
});

function io(over: Partial<CouponReplaceIO> = {}) {
  const codes = ['OPS-TAKEN111', 'OPS-FREE2222'];
  return {
    codeTaken: vi.fn(async (c: string) => c === 'OPS-TAKEN111'),
    create: vi.fn(async () => ({})),
    enqueue: vi.fn(async () => ({ ok: true })),
    abandon: vi.fn(async () => ({})),
    newId: vi.fn(() => 'new-1'),
    newCode: vi.fn(() => codes.shift() ?? 'OPS-LAST3333'),
    ...over,
  } satisfies CouponReplaceIO;
}

describe('starting an edit from a portal', () => {
  it('finds a free code, creates the replacement, then hands it over', async () => {
    const x = io();
    const out = await startCouponReplacement(x, {
      old: OLD,
      terms: TERMS,
      editorId: 'sup-1',
      reason: 'typo',
      now: TODAY,
    });
    expect(out).toEqual({ replacementId: 'new-1', code: 'OPS-FREE2222' });
    expect(x.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-1', replaces: 'old-1', coupon_code: 'OPS-FREE2222' }),
    );
    expect(x.enqueue).toHaveBeenCalledWith({
      couponApprovalId: 'old-1',
      replacementId: 'new-1',
      reason: 'typo',
    });
    expect(x.abandon).not.toHaveBeenCalled();
  });

  it('refuses without a reason or with bad terms, creating nothing', async () => {
    const x = io();
    await expect(
      startCouponReplacement(x, { old: OLD, terms: TERMS, editorId: 'u', reason: ' ', now: TODAY }),
    ).rejects.toBeInstanceOf(CouponReplaceNotStarted);
    await expect(
      startCouponReplacement(x, {
        old: OLD,
        terms: { ...TERMS, coupon_value: 0 },
        editorId: 'u',
        reason: 'x',
        now: TODAY,
      }),
    ).rejects.toThrow(/worth 0/);
    expect(x.create).not.toHaveBeenCalled();
  });

  it('a failed hand-off ABANDONS the replacement at once - nothing half-made counts', async () => {
    const x = io({ enqueue: vi.fn(async () => Promise.reject(new Error('403'))) });
    await expect(
      startCouponReplacement(x, { old: OLD, terms: TERMS, editorId: 'u', reason: 'x', now: TODAY }),
    ).rejects.toThrow(/original coupon was kept/);
    expect(x.abandon).toHaveBeenCalledWith(
      'new-1',
      expect.stringMatching(/original coupon was kept/),
    );
  });
});

describe('waiting for the workers', () => {
  const sleep = async () => undefined;
  it('returns done once the old row is claimed and removed', async () => {
    const reads = [
      { replacement: { id: 'n', status: 'approved' }, old: { replaced_by: null } },
      {
        replacement: { id: 'n', status: 'approved' },
        old: { replaced_by: 'n', removal_status: 'removed' },
      },
    ];
    const out = await waitForCouponReplacement(async () => reads.shift()!, { sleep });
    expect(out.state).toBe('done');
  });
  it('returns refused with the note when the workers rolled it back', async () => {
    const out = await waitForCouponReplacement(
      async () => ({
        replacement: { id: 'n', status: 'rejected', decision_note: 'Not changed: already used' },
        old: null,
      }),
      { sleep },
    );
    expect(out).toEqual({ state: 'refused', note: 'Not changed: already used' });
  });
  it('gives up after the timeout as "working" - nothing is lost', async () => {
    const read = vi.fn(async () => ({ replacement: { id: 'n', status: 'approved' }, old: null }));
    const out = await waitForCouponReplacement(read, { sleep, intervalMs: 10, timeoutMs: 30 });
    expect(out.state).toBe('working');
    expect(read).toHaveBeenCalledTimes(4);
  });
});
