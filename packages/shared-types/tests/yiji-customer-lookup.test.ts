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

/**
 * The same conversion the lookup applies, kept in step with the source.
 *
 * The CRM holds `0540041059`; Yiji holds `+966540041059`. One number, two
 * spellings, and converting between them IS the job.
 */
const digitsOf = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '').replace(/^00/, '');

/** The CRM's number in the form Yiji should be holding it. */
const toYijiForm = (crm: string) => {
  const national = digitsOf(crm).replace(/^966/, '').replace(/^0+/, '');
  return `966${national}`;
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
const pick = (rows: typeof ROWS, crm: string): string | null => {
  const want = toYijiForm(crm);
  const matches = rows.filter((r) => digitsOf(r.phoneNumber) === want);
  const ids = [...new Set(matches.map((r) => r.id.trim()).filter(Boolean))];
  return ids.length === 1 ? (ids[0] ?? null) : null;
};

describe('converting a CRM number to the form Yiji holds', () => {
  /* Every spelling an agent might type becomes the one canonical answer. */
  it.each([
    ['0540041059', '966540041059'],
    ['+966540041059', '966540041059'],
    ['540041059', '966540041059'],
    ['00966540041059', '966540041059'],
  ])('turns %s into %s', (input, expected) => {
    expect(toYijiForm(input)).toBe(expected);
  });
});

describe('choosing between several accounts on one number', () => {
  /*
   * THE WHOLE POINT, and the owner's own words (2026-10-04): "if on crm the
   * number is 0540041059, then on yiji it is +966540041059".
   *
   * `+9660540041059` — the country code followed by a trunk zero — is NOT that
   * number. It is a malformed row, so it cannot win and cannot make the answer
   * ambiguous. Ayman Hussien is the only account that actually holds the
   * number asked for.
   */
  it('picks the account whose number is exactly right', () => {
    expect(pick(ROWS, '0540041059')).toBe('c2d49e8c');
  });

  it('would have picked a TEST account under the old endsWith rule', () => {
    const old = ROWS.find((r) => r.phoneNumber.replace(/\D/g, '').endsWith('540041059'));
    expect(old?.id).toBe('76fe9966');
    expect(old?.id).not.toBe('c2d49e8c');
  });

  /*
   * AND IT WOULD HAVE REFUSED under the first attempt at a fix, which stripped
   * the trunk zero AFTER the country code — making `+9660…` and `+966…`
   * compare equal, so a perfectly good match sat behind an "ambiguous"
   * refusal it should never have been part of.
   */
  it('is not blocked by the malformed rows beside it', () => {
    expect(pick(ROWS, '0540041059')).not.toBeNull();
  });

  /* The ordinary case: one account, one answer. */
  it('resolves a number held by exactly one account', () => {
    expect(pick([{ id: 'only', phoneNumber: '+966501234567' }], '0501234567')).toBe('only');
  });

  /* Duplicate ROWS for the SAME account are not ambiguity — Yiji's search can
     return one customer more than once, and one id is still one person. */
  it('accepts the same account listed twice', () => {
    expect(
      pick(
        [
          { id: 'same', phoneNumber: '+966501234567' },
          { id: 'same', phoneNumber: '00966501234567' },
        ],
        '0501234567',
      ),
    ).toBe('same');
  });

  /*
   * STILL REFUSES WHEN GENUINELY AMBIGUOUS. Two DIFFERENT accounts both
   * holding the correct number is unresolvable, and guessing is what this
   * function exists to prevent.
   */
  it('refuses when two real accounts share the number', () => {
    expect(
      pick(
        [
          { id: 'one', phoneNumber: '+966501234567' },
          { id: 'two', phoneNumber: '+966501234567' },
        ],
        '0501234567',
      ),
    ).toBeNull();
  });

  it('answers null when nothing matches', () => {
    expect(pick([{ id: 'other', phoneNumber: '+966509999999' }], '0501234567')).toBeNull();
  });

  /* A malformed row ALONE is still not the number asked for. Better no coupon
     than a coupon to an account whose number is wrong. */
  it('does not settle for a malformed row even when it is the only one', () => {
    expect(pick([{ id: 'bad', phoneNumber: '+9660540041059' }], '0540041059')).toBeNull();
  });
});

/** And the source must still be doing it this way. */
const SRC = readFileSync(resolve(import.meta.dirname, '../src/yiji-impl.ts'), 'utf8');

describe('the lookup source', () => {
  it('no longer matches on endsWith', () => {
    expect(SRC).not.toMatch(/\.endsWith\(national\)/);
  });

  /* The CRM number is converted ONCE into the form Yiji should hold, and a row
     matches only if it is that exact string. */
  it('compares against the full Yiji number', () => {
    expect(SRC).toContain('const e164 = `966${national}`');
    expect(SRC).toMatch(/digitsOf\(r\?\.phoneNumber\) === e164/);
  });

  /* The trunk zero must NOT be stripped from the STORED side, or a malformed
     `+9660…` row compares equal to the real number all over again. */
  it('does not strip leading zeros from the stored number', () => {
    const fn = SRC.slice(SRC.indexOf('const digitsOf'), SRC.indexOf('const matches'));
    expect(fn).not.toMatch(/\^0\+/);
  });

  it('refuses an ambiguous answer', () => {
    expect(SRC).toMatch(/if \(ids\.length !== 1\) return null/);
  });
});
