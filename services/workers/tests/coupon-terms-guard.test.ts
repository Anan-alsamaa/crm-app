import { describe, expect, it } from 'vitest';
// @ts-expect-error - a plain-JS Directus hook, no types
import guard, {
  sameTerm,
  couponIncomplete,
} from '../../../directus/extensions/coupon-terms-guard/index.js';

/**
 * Once a coupon is ON YIJI, only the workers change its terms (owner,
 * 2026-11-12: Yiji and the CRM must never disagree). A PATCH from anyone else
 * - the Administrator included - that changes a term is refused; resending the
 * same values passes; a coupon not on Yiji yet is free to change.
 */
type Row = Record<string, unknown>;
const COMPLETE: Row = {
  coupon_type: 'Private',
  discount_category: 'Amount',
  coupon_value: 3,
  coupon_percent: null,
  max_discount: '3.00000',
  valid_from: '2026-11-13',
  valid_to: '2026-12-11',
  usage_limit: 1,
  total_discount_limit: '3.00000',
};
const ROWS: Row[] = [
  { ...COMPLETE, id: 'on', coupon_code: 'OPS-ON', yiji_coupon_id: '89126' },
  { ...COMPLETE, id: 'off', coupon_code: 'OPS-OFF', yiji_coupon_id: null },
  /* The 13 Nov request from the ticket Edit form: an amount and nothing else. */
  {
    id: 'bare',
    coupon_code: null,
    yiji_coupon_id: null,
    coupon_value: 10,
    coupon_type: null,
    discount_category: null,
    valid_from: null,
    valid_to: null,
    usage_limit: null,
    total_discount_limit: null,
    max_discount: null,
    coupon_percent: null,
  },
];
const ROLES: Record<string, string> = {
  r1: 'svc-workers',
  r2: 'WeCare Supervisor',
  r3: 'Administrator',
};

function fakeDb() {
  return (table: string) => {
    const q: { ids?: string[]; notNull?: string; where?: Row } = {};
    const b = {
      where(w: Row) {
        q.where = w;
        return b;
      },
      whereIn(_c: string, ids: string[]) {
        q.ids = ids;
        return b;
      },
      whereNotNull(c: string) {
        q.notNull = c;
        return b;
      },
      async first() {
        return table === 'directus_roles' ? { name: ROLES[String(q.where?.id)] } : null;
      },
      async select() {
        return ROWS.filter(
          (r) => q.ids?.includes(String(r.id)) && (!q.notNull || r[q.notNull] != null),
        );
      },
    };
    return b;
  };
}

type Filter = (p: Row, m: Row, c: Row) => Promise<Row>;
function hook(event = 'coupon_approvals.items.update') {
  const fns: Record<string, Filter> = {};
  guard({ filter: (e: string, f: Filter) => (fns[e] = f) }, { database: fakeDb() });
  return (payload: Row, keys: string[], role: string | null) =>
    fns[event]!(
      payload,
      { keys },
      role === null ? {} : { accountability: { role, admin: role === 'r3' } },
    );
}

describe('coupon terms guard', () => {
  const run = hook();
  it('refuses a supervisor changing the amount of a coupon already on Yiji', async () => {
    await expect(run({ coupon_value: 9 }, ['on'], 'r2')).rejects.toThrow(
      /already on Yiji: its terms \(coupon_value\)/,
    );
  });
  it('refuses the Administrator too - the edit is the only way', async () => {
    await expect(run({ valid_to: '2027-01-01' }, ['on'], 'r3')).rejects.toThrow(/valid_to/);
  });
  it('lets the workers write the edited terms', async () => {
    await expect(run({ coupon_value: 9 }, ['on'], 'r1')).resolves.toEqual({ coupon_value: 9 });
  });
  it('lets anyone change a coupon not on Yiji yet (approval, amendments)', async () => {
    await expect(run({ coupon_value: 9, total_discount_limit: 9 }, ['off'], 'r2')).resolves.toEqual(
      { coupon_value: 9, total_discount_limit: 9 },
    );
  });
  it('passes the same values spelled differently, and non-term fields', async () => {
    await expect(
      run({ coupon_value: '3', max_discount: 3, valid_to: '2026-12-11T00:00:00' }, ['on'], 'r2'),
    ).resolves.toBeTruthy();
    await expect(
      run({ status: 'assigned', yiji_push_error: null }, ['on'], 'r2'),
    ).resolves.toBeTruthy();
  });
  it('sameTerm', () => {
    expect(sameTerm('coupon_value', '3.00000', 3)).toBe(true);
    expect(sameTerm('item_name', '', null)).toBe(true);
    expect(sameTerm('coupon_value', 3, 4)).toBe(false);
    expect(sameTerm('no_other_discounts', false, 'false')).toBe(true);
  });
});

/**
 * EVERY COUPON IS COMPLETE (owner, 2026-11-14): no create, edit or approval of
 * a coupon missing its type, category, amount, dates, uses or total limit.
 */
describe('coupon completeness', () => {
  const create = hook('coupon_approvals.items.create');
  const update = hook();
  const R4 = 'r2';
  it('refuses creating a coupon with only an amount (the 13 Nov request)', async () => {
    await expect(create({ coupon_value: 10, compensation: 'Compensated' }, [], R4)).rejects.toThrow(
      /coupon type .*discount category.*valid from date.*valid to date.*number of uses.*total discount limit/,
    );
  });
  it('accepts a complete Private coupon - its limit is uses x amount', async () => {
    await expect(create({ ...COMPLETE, total_discount_limit: null }, [], R4)).resolves.toBeTruthy();
  });
  it('a General coupon needs its typed limit', async () => {
    await expect(
      create({ ...COMPLETE, coupon_type: 'General', total_discount_limit: null }, [], R4),
    ).rejects.toThrow(/total discount limit/);
    await expect(create({ ...COMPLETE, coupon_type: 'General' }, [], R4)).resolves.toBeTruthy();
  });
  it('a percentage coupon needs its percent and cap; dates must be in order', async () => {
    expect(
      couponIncomplete({
        ...COMPLETE,
        discount_category: 'Percentage',
        coupon_percent: 10,
        max_discount: null,
      }),
    ).toContain('maximum discount');
    expect(couponIncomplete({ ...COMPLETE, valid_from: '2026-12-12' })).toContain(
      'valid to date (it is before the start date)',
    );
    expect(couponIncomplete({ ...COMPLETE, usage_limit: 0 })).toContain('number of uses');
    expect(couponIncomplete({ ...COMPLETE, coupon_type: 'Gold' })).toContain(
      'coupon type (Private or General)',
    );
    expect(couponIncomplete({ ...COMPLETE, total_discount_limit: 2 })).toContain(
      'total discount limit (below one use)',
    );
    expect(couponIncomplete(COMPLETE)).toEqual([]);
  });
  it('an edit of ONE value keeps every other value - judged on the merged coupon', async () => {
    await expect(
      update({ coupon_value: 5, total_discount_limit: 5 }, ['off'], R4),
    ).resolves.toBeTruthy();
    await expect(update({ valid_to: null }, ['off'], R4)).rejects.toThrow(/valid to date/);
  });
  it('an incomplete request cannot be approved, but can be rejected or completed', async () => {
    await expect(update({ status: 'approved' }, ['bare'], R4)).rejects.toThrow(/not complete/);
    await expect(
      update({ status: 'rejected', decision_note: 'x' }, ['bare'], R4),
    ).resolves.toBeTruthy();
    await expect(
      update(
        { ...COMPLETE, coupon_value: 10, max_discount: 10, total_discount_limit: 10 },
        ['bare'],
        R4,
      ),
    ).resolves.toBeTruthy();
  });
  it('the workers and Directus itself are not judged here', async () => {
    await expect(create({ coupon_value: 1 }, [], 'r1')).resolves.toBeTruthy();
    await expect(create({ coupon_value: 1 }, [], null)).resolves.toBeTruthy();
  });
});

/* Staging, 2026-11-14: the database returns a `date` as a JS Date. */
describe('dates as the database returns them', () => {
  it('a stored Date counts as a date, and as the same day as its string', () => {
    const stored = new Date(2026, 11, 3);
    expect(
      couponIncomplete({ ...COMPLETE, valid_from: new Date(2026, 10, 13), valid_to: stored }),
    ).toEqual([]);
    expect(sameTerm('valid_to', stored, '2026-12-03')).toBe(true);
    expect(sameTerm('valid_to', stored, '2026-12-04')).toBe(false);
  });
});
