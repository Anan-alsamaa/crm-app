import { describe, expect, it } from 'vitest';
// @ts-expect-error - a plain-JS Directus hook, no types
import guard, { sameTerm } from '../../../directus/extensions/coupon-terms-guard/index.js';

/**
 * Once a coupon is ON YIJI, only the workers change its terms (owner,
 * 2026-11-12: Yiji and the CRM must never disagree). A PATCH from anyone else
 * - the Administrator included - that changes a term is refused; resending the
 * same values passes; a coupon not on Yiji yet is free to change.
 */
type Row = Record<string, unknown>;
const ROWS: Row[] = [
  {
    id: 'on',
    coupon_code: 'OPS-ON',
    yiji_coupon_id: '89126',
    coupon_value: 3,
    max_discount: '3.00000',
    valid_to: '2026-12-11',
  },
  {
    id: 'off',
    coupon_code: 'OPS-OFF',
    yiji_coupon_id: null,
    coupon_value: 3,
    max_discount: '3.00000',
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

function hook() {
  let fn: ((p: Row, m: Row, c: Row) => Promise<Row>) | null = null;
  guard({ filter: (_e: string, f: typeof fn) => (fn = f) }, { database: fakeDb() });
  return (payload: Row, keys: string[], role: string | null) =>
    fn!(payload, { keys }, role === null ? {} : { accountability: { role, admin: role === 'r3' } });
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
    await expect(run({ coupon_value: 9 }, ['off'], 'r2')).resolves.toEqual({ coupon_value: 9 });
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
