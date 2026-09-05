import { describe, it, expect } from 'vitest';
import { isPhoneDerivedCustomerId, normalizePhone, phoneCustomerId } from '../src/phone.js';

/*
 * These rules exist because contacts are matched by exact phone equality. A
 * walk-in customer typing 05… and the Yiji app sending +9665… are the same
 * person, and before this they became two contacts — so a registered customer
 * arriving via the store QR code got no order history.
 */

describe('normalizePhone', () => {
  it('canonicalises to the LOCAL form — the one people actually use', () => {
    /*
     * `05XXXXXXXX` is what an agent reads out on a call, what a customer types,
     * and what a branch prints. Storing the same string means a number copied
     * from a ticket into a dialler works, and a search for what the customer
     * told you finds them.
     */
    expect(normalizePhone('0555123456')).toBe('0555123456');
  });

  it('brings the country code home rather than leaving two spellings', () => {
    // The live table held FOUR shapes at once and two customers were in it
    // twice under two spellings of the same number.
    expect(normalizePhone('+966555123456')).toBe('0555123456');
    expect(normalizePhone('966555123456')).toBe('0555123456');
  });

  it('agrees across every way one number gets written', () => {
    const forms = [
      '0555123456',
      '+966555123456',
      '966555123456',
      '+966 55 512 3456',
      '(0) 555-123-456',
      '555123456',
    ];
    const seen = new Set(forms.map(normalizePhone));
    expect([...seen]).toEqual(['0555123456']);
  });

  it('drops a trunk zero left in after the country code', () => {
    // "+966 05…" is a real thing people type.
    expect(normalizePhone('+9660555123456')).toBe('0555123456');
  });

  it('collapses a doubled trunk zero without eating the real one', () => {
    expect(normalizePhone('00555123456')).toBe('0555123456');
  });

  it('will not hand a leading 0 to something that is not a mobile number', () => {
    // Length-checked, so a stray 5-leading string is left visibly wrong rather
    // than dressed up as a number. There is one such value in the live table —
    // 18 digits, from a mis-paste — and leaving it alone is what lets somebody
    // notice it.
    expect(normalizePhone('508317417558378794')).toBe('508317417558378794');
  });

  it('keeps a foreign number rather than pretending it is Saudi', () => {
    expect(normalizePhone('+447700900123')).toBe('+447700900123');
  });

  it('returns the input untouched when there is nothing to work with', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhone('  ')).toBe('');
  });

  it('does not invent a number from punctuation alone', () => {
    expect(normalizePhone('+++')).toBe('+++');
  });
});

describe('phoneCustomerId', () => {
  it('is the same id however the number was typed', () => {
    // The point is agreement, not the particular digits: one handset, one id,
    // whichever spelling it arrived in.
    expect(phoneCustomerId('0555123456')).toBe('cust-0555123456');
    expect(phoneCustomerId('+966555123456')).toBe('cust-0555123456');
    expect(phoneCustomerId('966 555 123 456')).toBe('cust-0555123456');
  });
});

describe('isPhoneDerivedCustomerId', () => {
  /*
   * A walk-in visitor types a phone number into the QR page and the gateway
   * mints `cust-<digits>` so the session has an identity. That is a fine local
   * handle and it is NOT a Yiji customer id — but it was being written into
   * `contacts.external_customer_id`, a column whose entire meaning is "the id
   * Yiji issued". Five contacts carried one, and the coupon push sends that
   * column to Yiji as `userId`.
   */
  it('recognises the ids WE mint from a phone number', () => {
    expect(isPhoneDerivedCustomerId(phoneCustomerId('0501234567'))).toBe(true);
    expect(isPhoneDerivedCustomerId('cust-966501234567')).toBe(true);
  });

  it('does not mistake a real Yiji id for one of ours', () => {
    // Whatever shape their ids take, they are not `cust-` + digits.
    for (const real of ['900123', 'yiji-77', 'C-4417', 'cust', 'custom-1', 'cust-abc']) {
      expect(isPhoneDerivedCustomerId(real)).toBe(false);
    }
  });

  it('treats absence as absence', () => {
    expect(isPhoneDerivedCustomerId(null)).toBe(false);
    expect(isPhoneDerivedCustomerId(undefined)).toBe(false);
    expect(isPhoneDerivedCustomerId('')).toBe(false);
  });

  it('round-trips with the minting function for every phone shape', () => {
    // The two are the same fact read in opposite directions; if they ever
    // disagree, a fabricated id reaches Yiji.
    for (const p of ['0501234567', '+966501234567', '966501234567', '05 0123 4567']) {
      expect(isPhoneDerivedCustomerId(phoneCustomerId(p))).toBe(true);
    }
  });
});

describe('one stored shape — 05XXXXXXXX', () => {
  /*
   * The owner's rule (2026-09-05): one format exists in this system and it is
   * `05XXXXXXXX`. Everything that WRITES a phone must land on it, whatever was
   * typed or sent — the Yiji app sends `+9665…`, a counter types `05…`, and an
   * agent editing a contact might paste either. Two spellings of one customer
   * is a customer who cannot be found by equality, which is how a returning
   * walk-in looked like a new person.
   */
  it.each([
    ['+966537301009', '0537301009'],
    ['966537301009', '0537301009'],
    ['+966 53 730 1009', '0537301009'],
    ['00966537301009', '0537301009'],
    ['0537301009', '0537301009'],
    ['537301009', '0537301009'],
    ['05 3730 1009', '0537301009'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('leaves a genuinely foreign number alone rather than claiming it is Saudi', () => {
    // Prefixing a 0 onto a UK or UAE number would invent a Saudi customer.
    expect(normalizePhone('+971501234567')).toBe('+971501234567');
    expect(normalizePhone('+447700900123')).toBe('+447700900123');
  });
});
