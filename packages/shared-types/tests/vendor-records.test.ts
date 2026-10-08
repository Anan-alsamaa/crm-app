import { describe, expect, it } from 'vitest';
import {
  activeVendorsOf,
  pickRecordVendor,
  preferVendorScoped,
  showVendorUi,
  soleActiveVendorId,
  vendorIdOf,
  vendorScopeMatches,
  vendorsFromRows,
} from '../src/index.js';

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

describe('vendor UI visibility (MV-4)', () => {
  it('is hidden with one active vendor, shown with two', () => {
    expect(showVendorUi([{ id: 'a', status: 'active' }])).toBe(false);
    expect(
      showVendorUi([
        { id: 'a', status: 'active' },
        { id: 'b', status: 'inactive' },
      ]),
    ).toBe(false);
    expect(
      showVendorUi([
        { id: 'a', status: 'active' },
        { id: 'b', status: null },
      ]),
    ).toBe(true);
    expect(showVendorUi(null)).toBe(false);
    expect(activeVendorsOf([{ id: 'a' }, { id: 'b', status: 'inactive' }])).toEqual([{ id: 'a' }]);
  });
});

describe('vendor-scoped settings (MV-4)', () => {
  it('NULL applies to every vendor; a named vendor only to its own', () => {
    expect(vendorScopeMatches(null, 'v1')).toBe(true);
    expect(vendorScopeMatches(null, null)).toBe(true);
    expect(vendorScopeMatches('v1', 'v1')).toBe(true);
    expect(vendorScopeMatches({ id: 'v1' }, { id: 'v1' })).toBe(true);
    expect(vendorScopeMatches('v1', 'v2')).toBe(false);
    expect(vendorScopeMatches('v1', null)).toBe(false);
  });

  it('prefers the vendor own rows, else the shared ones, never another vendor', () => {
    const rows = [
      { id: 'shared', vendor: null },
      { id: 'v1-only', vendor: 'v1' },
      { id: 'v2-only', vendor: { id: 'v2' } },
    ];
    expect(preferVendorScoped(rows, 'v1').map((r) => r.id)).toEqual(['v1-only']);
    expect(preferVendorScoped(rows, 'v2').map((r) => r.id)).toEqual(['v2-only']);
    expect(preferVendorScoped(rows, 'v3').map((r) => r.id)).toEqual(['shared']);
    expect(preferVendorScoped(rows, null).map((r) => r.id)).toEqual(['shared']);
    // One vendor, no scoped rows: unchanged behaviour.
    expect(preferVendorScoped([{ id: 'a' }, { id: 'b' }], 'v1').map((r) => r.id)).toEqual([
      'a',
      'b',
    ]);
  });
});
