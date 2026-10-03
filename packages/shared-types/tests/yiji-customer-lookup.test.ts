import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * WHICH YIJI CUSTOMER A PHONE NUMBER MEANS — AND WHEN TO REFUSE TO GUESS.
 *
 * A coupon granted to the wrong account cannot be revoked from our side, so
 * this lookup is the last place a guess is acceptable.
 *
 * IT USED TO GUESS. The match was `endsWith(national)`, and production showed
 * what that costs (owner, 2026-10-03). Asked to send a coupon to `0540041059`,
 * Yiji returned FIVE accounts:
 *
 *     +9660540041059   testFrist testLast     <- country code AND a trunk zero
 *     +9660540041059   testFrist testLast
 *     +9660540041059   testFrist testLast
 *     +966540041059    Ayman Hussien          <- the real customer
 *     +9660540041059   testFrist testLast
 *
 * All five END with `540041059`, so `endsWith` took whichever Yiji listed
 * first — a test account, not Ayman. The coupon was never created, because the
 * lookup was checked before it ran.
 *
 * The comparison is now on the NATIONAL number, normalised identically on both
 * sides, and an ambiguous answer is refused outright.
 *
 * Asserted against the SOURCE: `findCustomerIdByPhone` is a method on an HTTP
 * client that signs in to Yiji's admin API, and mocking that to observe one
 * comparison would be testing the mock. The normalisation is the whole fix, so
 * it is reproduced here against the EXACT rows production returned.
 */

/** The same normalisation the lookup applies, kept in step with the source. */
const nationalOf = (v: string | null | undefined) => {
  const d = (v ?? '').replace(/\D/g, '').replace(/^00/, '');
  return d.replace(/^966/, '').replace(/^0+/, '');
};

/** The real rows Yiji returned for 0540041059 on 2026-10-03. */
const ROWS = [
  { id: '76fe9966', phoneNumber: '+9660540041059' },
  { id: '8a541b79', phoneNumber: '+9660540041059' },
  { id: 'b1ca8969', phoneNumber: '+9660540041059' },
  { id: 'c2d49e8c', phoneNumber: '+966540041059' },
  { id: 'e6adf1d1', phoneNumber: '+9660540041059' },
];

/** The lookup's decision, reproduced. */
const pick = (rows: typeof ROWS, national: string): string | null => {
  const matches = rows.filter((r) => nationalOf(r.phoneNumber) === national);
  const ids = [...new Set(matches.map((r) => r.id.trim()).filter(Boolean))];
  return ids.length === 1 ? (ids[0] ?? null) : null;
};

describe('normalising a Saudi number', () => {
  /* Every spelling of ONE number reduces to the same national part. */
  it.each([
    ['+966540041059', '540041059'],
    ['0540041059', '540041059'],
    ['540041059', '540041059'],
    ['00966540041059', '540041059'],
  ])('reduces %s to %s', (input, expected) => {
    expect(nationalOf(input)).toBe(expected);
  });

  /*
   * THE MALFORMED ONE THAT CAUSED THIS. `+9660540041059` is the country code
   * followed by the trunk zero — not a valid number, but four accounts are
   * stored that way. It must reduce to the SAME national part, or those
   * accounts become unreachable instead of merely ambiguous.
   */
  it('reduces a country code followed by a trunk zero', () => {
    expect(nationalOf('+9660540041059')).toBe('540041059');
  });

  /* A different, longer number must NOT reduce to this one — that is what
     `endsWith` could not tell apart. */
  it('keeps a longer number distinct', () => {
    expect(nationalOf('+966555540041059')).not.toBe('540041059');
  });
});

describe('choosing between several accounts on one number', () => {
  /*
   * THE REGRESSION ITSELF. Five accounts, two different people. The honest
   * answer is "I cannot tell", and the coupon stays approved and undelivered —
   * which a human can see and resolve. A silent grant to the wrong account is
   * neither visible nor reversible.
   */
  it('refuses to guess when the number is ambiguous', () => {
    expect(pick(ROWS, '540041059')).toBeNull();
  });

  it('would have picked a TEST account under the old endsWith rule', () => {
    const old = ROWS.find((r) => r.phoneNumber.replace(/\D/g, '').endsWith('540041059'));
    expect(old?.id).toBe('76fe9966');
    /* Not Ayman Hussien, who is `c2d49e8c`. */
    expect(old?.id).not.toBe('c2d49e8c');
  });

  /* The ordinary case still resolves: one account, one answer. */
  it('resolves a number held by exactly one account', () => {
    expect(pick([{ id: 'only', phoneNumber: '+966501234567' }], '501234567')).toBe('only');
  });

  /* Duplicate ROWS for the SAME account are not ambiguity — Yiji's search can
     return a customer more than once, and one id is still one person. */
  it('accepts the same account listed twice', () => {
    expect(
      pick(
        [
          { id: 'same', phoneNumber: '+966501234567' },
          { id: 'same', phoneNumber: '0501234567' },
        ],
        '501234567',
      ),
    ).toBe('same');
  });

  it('answers null when nothing matches', () => {
    expect(pick([{ id: 'other', phoneNumber: '+966509999999' }], '501234567')).toBeNull();
  });
});

/** And the source must still be doing it this way. */
const SRC = readFileSync(resolve(import.meta.dirname, '../src/yiji-impl.ts'), 'utf8');

describe('the lookup source', () => {
  it('no longer matches on endsWith', () => {
    expect(SRC).not.toMatch(/\.replace\(\/\\D\/g, ''\)\.endsWith\(national\)/);
  });

  it('compares the normalised national number', () => {
    expect(SRC).toMatch(/nationalOf\(r\?\.phoneNumber\) === national/);
  });

  it('refuses an ambiguous answer', () => {
    expect(SRC).toMatch(/if \(ids\.length !== 1\) return null/);
  });
});
