import { describe, expect, it } from 'vitest';
import { redact, redactDeep, unredact, luhnValid, ibanValid } from '../src/redaction/index.js';

describe('PII redaction', () => {
  it('redacts a plain email', () => {
    const { redacted, entries } = redact('Contact me at jane.doe@example.com please.');
    expect(redacted).toBe('Contact me at <EMAIL_1> please.');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ category: 'email', raw: 'jane.doe@example.com' });
  });

  it('redacts multiple emails with incrementing placeholders', () => {
    const { redacted } = redact('a@b.com and c@d.com');
    expect(redacted).toBe('<EMAIL_1> and <EMAIL_2>');
  });

  it('redacts an international phone number', () => {
    const { redacted, entries } = redact('Ring +1 (555) 123-4567 anytime.');
    expect(redacted).toBe('Ring <PHONE_1> anytime.');
    expect(entries[0]?.category).toBe('phone');
  });

  it('redacts a local 10-digit phone', () => {
    const { redacted } = redact('Call 5551234567 today.');
    expect(redacted).toBe('Call <PHONE_1> today.');
  });

  it('does NOT redact a 4-digit year as a phone', () => {
    const { redacted } = redact('Order #5921 placed in 2024 yesterday.');
    expect(redacted).toContain('2024');
  });

  it('redacts a Luhn-valid card number (Visa test number)', () => {
    const { redacted, entries } = redact('Card on file: 4242 4242 4242 4242 expires soon.');
    expect(redacted).toBe('Card on file: <CARD_1> expires soon.');
    expect(entries[0]?.category).toBe('card');
  });

  it('does NOT redact a 16-digit Luhn-INVALID run', () => {
    const { redacted } = redact('Ref: 1234567890123456 (random)');
    expect(redacted).toContain('1234567890123456');
  });

  it('redacts an IBAN (DE89 test value)', () => {
    const { redacted, entries } = redact('Send to DE89370400440532013000 ASAP.');
    expect(redacted).toBe('Send to <IBAN_1> ASAP.');
    expect(entries[0]?.category).toBe('iban');
  });

  it('does NOT redact a malformed IBAN', () => {
    const { redacted } = redact('Code ZZ00ZZZZZZZZZZZZZZZ should pass through.');
    expect(redacted).toContain('ZZ00ZZZZZZZZZZZZZZZ');
  });

  it('redacts a US-style national ID', () => {
    const { redacted } = redact('SSN 123-45-6789 on the form.');
    expect(redacted).toBe('SSN <NATIONAL_ID_1> on the form.');
  });

  it('redacts a street address', () => {
    const { redacted, entries } = redact('Ship to 742 Evergreen Terrace, Springfield.');
    expect(redacted).toContain('<ADDRESS_1>');
    expect(entries.some((e) => e.category === 'address')).toBe(true);
  });

  it('redacts a PO Box', () => {
    const { redacted } = redact('Mail to PO Box 1234 for refunds.');
    expect(redacted).toBe('Mail to <ADDRESS_1> for refunds.');
  });

  it('redacts a card AND email + phone in the same string with consistent numbering', () => {
    const { redacted } = redact(
      'My card 4242 4242 4242 4242, email j@example.com, phone +44 20 7946 0958',
    );
    expect(redacted).toBe('My card <CARD_1>, email <EMAIL_1>, phone <PHONE_1>');
  });

  it('does not leak any of the original values when redacted', () => {
    const original =
      'Jane jane@example.com 4242424242424242 +1-555-123-4567 DE89370400440532013000 123-45-6789';
    const { redacted } = redact(original);
    expect(redacted).not.toContain('jane@example.com');
    expect(redacted).not.toContain('4242424242424242');
    expect(redacted).not.toContain('555-123-4567');
    expect(redacted).not.toContain('DE89370400440532013000');
    expect(redacted).not.toContain('123-45-6789');
  });

  it('redactDeep walks nested objects + arrays + leaves non-strings alone', () => {
    const input = {
      conversationId: 'abc',
      messages: [
        { from: 'customer', text: 'Email me at hi@x.com' },
        { from: 'agent', text: 'Got it', priority: 3 },
      ],
      meta: { active: true, tags: ['urgent', 'contact: foo@bar.com'] },
    };
    const { redacted, entries } = redactDeep(input);
    expect(redacted.conversationId).toBe('abc');
    expect(redacted.messages[0]?.text).toBe('Email me at <EMAIL_1>');
    expect(redacted.messages[1]?.priority).toBe(3);
    expect(redacted.meta.tags[1]).toBe('contact: <EMAIL_2>');
    expect(entries.filter((e) => e.category === 'email')).toHaveLength(2);
  });

  it('unredact restores original values', () => {
    const { redacted, entries } = redact('Email me jane@example.com or call 555-123-4567');
    const restored = unredact(redacted, entries);
    expect(restored).toBe('Email me jane@example.com or call 555-123-4567');
  });
});

describe('luhnValid', () => {
  it('accepts known valid card test numbers', () => {
    expect(luhnValid('4242424242424242')).toBe(true); // Visa test
    expect(luhnValid('5555555555554444')).toBe(true); // Mastercard test
    expect(luhnValid('378282246310005')).toBe(true); // Amex test
  });
  it('rejects obviously invalid numbers', () => {
    expect(luhnValid('1234567890123456')).toBe(false);
    expect(luhnValid('0000000000000000')).toBe(true); // technically valid Luhn
    expect(luhnValid('123')).toBe(false); // too short
    expect(luhnValid('42424242424242424242')).toBe(false); // too long
  });
});

describe('ibanValid', () => {
  it('accepts known valid IBANs', () => {
    expect(ibanValid('DE89370400440532013000')).toBe(true); // Germany
    expect(ibanValid('GB82WEST12345698765432')).toBe(true); // UK
    expect(ibanValid('FR1420041010050500013M02606')).toBe(true); // France
  });
  it('rejects wrong-checksum IBANs', () => {
    expect(ibanValid('DE89370400440532013001')).toBe(false);
  });
  it('rejects malformed IBANs', () => {
    expect(ibanValid('NOT_AN_IBAN')).toBe(false);
    expect(ibanValid('XX')).toBe(false);
  });
});
