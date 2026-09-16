import { describe, it, expect } from 'vitest';
import { isDialablePhone } from '../src/phone.js';

/*
 * ONE FIELD TAKES A NAME OR A NUMBER (owner, 2026-09-16).
 *
 * The Add-ticket page offers to create a customer only when what the agent
 * typed is actually a number. Getting this wrong is not cosmetic in either
 * direction: too strict and a real customer cannot be recorded, too loose and
 * a half-typed fragment becomes a permanent contact row.
 */
describe('isDialablePhone — a number to reach somebody on, or a name?', () => {
  it('accepts the shapes people actually type', () => {
    for (const ok of [
      '0501234567', // what a customer reads out
      '050 123 4567', // ...with the spacing they say it in
      '050-123-4567',
      '+966501234567',
      '+966 50 123 4567',
      '00966501234567', // the international prefix a contact card stores
      '966501234567',
      '501234567', // bare national, which autofill produces
      '+14155552671', // somewhere else entirely, and said so
    ]) {
      expect(isDialablePhone(ok), ok).toBe(true);
    }
  });

  it('rejects a name — the other thing this field accepts', () => {
    for (const name of ['Ahmed', 'Ahmed Al-Qahtani', 'أحمد', 'ahmed 050']) {
      expect(isDialablePhone(name), name).toBe(false);
    }
  });

  it('rejects a fragment, so typing does not offer to create a customer mid-way', () => {
    for (const partial of ['', '   ', '0', '05', '05012', '1234567']) {
      expect(isDialablePhone(partial), JSON.stringify(partial)).toBe(false);
    }
  });

  it('rejects a bare digit string too long to be a number', () => {
    // The live table holds one 18-digit mis-paste. It must not become a contact.
    expect(isDialablePhone('050123456789012345')).toBe(false);
  });
});
