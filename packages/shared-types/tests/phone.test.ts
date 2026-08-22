import { describe, it, expect } from 'vitest';
import { normalizePhone, phoneCustomerId } from '../src/phone.js';

/*
 * These rules exist because contacts are matched by exact phone equality. A
 * walk-in customer typing 05… and the Yiji app sending +9665… are the same
 * person, and before this they became two contacts — so a registered customer
 * arriving via the store QR code got no order history.
 */

describe('normalizePhone', () => {
  it('turns the local trunk form into E.164', () => {
    expect(normalizePhone('0555123456')).toBe('+966555123456');
  });

  it('leaves an already-canonical number alone', () => {
    expect(normalizePhone('+966555123456')).toBe('+966555123456');
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
    expect([...seen]).toEqual(['+966555123456']);
  });

  it('drops a trunk zero left in after the country code', () => {
    // "+966 05…" is a real thing people type.
    expect(normalizePhone('+9660555123456')).toBe('+966555123456');
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
    expect(phoneCustomerId('0555123456')).toBe('cust-966555123456');
    expect(phoneCustomerId('+966555123456')).toBe('cust-966555123456');
    expect(phoneCustomerId('966 555 123 456')).toBe('cust-966555123456');
  });
});
