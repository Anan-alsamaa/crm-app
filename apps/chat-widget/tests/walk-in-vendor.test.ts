import { describe, it, expect } from 'vitest';
import { walkInVendorId } from '../src/walk-in-vendor.js';

describe('walkInVendorId (MV-3)', () => {
  it('takes the vendor from the link', () => {
    expect(walkInVendorId('?vendor=2', '1')).toBe('2');
    expect(walkInVendorId('?c=X&vendor=acme-2', undefined)).toBe('acme-2');
  });

  it('falls back to the build-time value when the link has none', () => {
    expect(walkInVendorId('', '5')).toBe('5');
    expect(walkInVendorId('?vendor=', '5')).toBe('5');
  });

  it('falls back to 1 (Yiji) when neither is set', () => {
    expect(walkInVendorId('', undefined)).toBe('1');
    expect(walkInVendorId('', '  ')).toBe('1');
  });

  it('ignores a malformed parameter rather than sending it', () => {
    expect(walkInVendorId('?vendor=a%20b', '1')).toBe('1');
    expect(walkInVendorId(`?vendor=${'x'.repeat(65)}`, '1')).toBe('1');
  });
});
