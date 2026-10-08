import { describe, expect, it } from 'vitest';
import { pickRecordVendor, soleActiveVendorId, vendorIdOf, vendorsFromRows } from '../src/index.js';

describe('pickRecordVendor (MV-1)', () => {
  const one = [{ id: 'v-yiji', status: 'active' }];
  const two = [
    { id: 'v-yiji', status: 'active' },
    { id: 'v-two', status: 'active' },
  ];

  it('prefers explicit, then ticket, conversation, contact', () => {
    expect(
      pickRecordVendor({
        explicit: 'a',
        ticket: 'b',
        conversation: 'c',
        contact: 'd',
        vendors: one,
      }),
    ).toBe('a');
    expect(pickRecordVendor({ ticket: { id: 'b' }, conversation: 'c', contact: 'd' })).toBe('b');
    expect(pickRecordVendor({ ticket: null, conversation: 'c', contact: 'd' })).toBe('c');
    expect(pickRecordVendor({ contact: { id: 'd' } })).toBe('d');
  });

  it('falls back to the SINGLE active vendor', () => {
    expect(pickRecordVendor({ vendors: one })).toBe('v-yiji');
    expect(pickRecordVendor({ vendors: [...one, { id: 'v-off', status: 'inactive' }] })).toBe(
      'v-yiji',
    );
  });

  it('refuses to guess between two active vendors', () => {
    expect(pickRecordVendor({ vendors: two })).toBeNull();
    expect(pickRecordVendor({})).toBeNull();
    expect(soleActiveVendorId([])).toBeNull();
  });

  it('treats blank ids as absent', () => {
    expect(vendorIdOf('  ')).toBeNull();
    expect(vendorIdOf({ id: null })).toBeNull();
    expect(pickRecordVendor({ explicit: '', ticket: ' ', vendors: one })).toBe('v-yiji');
  });
});

describe('vendorsFromRows honours vendors.platform (MV-1)', () => {
  it('a NULL platform is yiji; a named one is carried through', () => {
    const vs = vendorsFromRows([
      { id: 'a', yiji_vendor_id: '1', status: 'active' },
      { id: 'b', yiji_vendor_id: '2', status: 'active', platform: null },
      { id: 'c', yiji_vendor_id: '3', status: 'active', platform: 'yiji' },
      { id: 'd', yiji_vendor_id: '4', status: 'active', platform: 'other' },
    ]);
    expect(vs.map((v) => v.platform)).toEqual(['yiji', 'yiji', 'yiji', 'other']);
  });
});
