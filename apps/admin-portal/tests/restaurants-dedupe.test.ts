import { describe, it, expect } from 'vitest';
import {
  brandKey,
  effectiveIdentity,
  foldName,
  normaliseStoreCode,
  partitionNew,
  storeKey,
} from '../src/features/restaurants/dedupe.js';

/**
 * Re-uploading the operations master must be a no-op, not 134 duplicates.
 * The fixtures below are the real shapes from that sheet.
 */

describe('normaliseStoreCode', () => {
  it('folds the four spellings the master uses to one', () => {
    for (const written of ['LCP-058', 'LCP058', 'lcp 058', 'LCP.058', 'LCP_058']) {
      expect(normaliseStoreCode(written)).toBe('LCP-058');
    }
  });

  it('keeps leading zeros — LCP-006 and LCP-6 are different stores', () => {
    expect(normaliseStoreCode('LCP-006')).not.toBe(normaliseStoreCode('LCP-6'));
  });

  it('is empty for nothing at all', () => {
    expect(normaliseStoreCode(null)).toBe('');
    expect(normaliseStoreCode('   ')).toBe('');
  });
});

describe('foldName', () => {
  it('ignores case, spacing, punctuation and accents', () => {
    expect(foldName('  Marina   Mall-2 ')).toBe(foldName('marina mall 2'));
    expect(foldName('Café Plaza')).toBe('cafe plaza');
  });
});

describe('effectiveIdentity', () => {
  it('recovers a code that lives inside the name', () => {
    // The master has rows where the code was never split into its own column.
    expect(effectiveIdentity({ code: null, name: 'LCP-006 Panorama Mall' })).toEqual({
      code: 'LCP-006',
      name: 'Panorama Mall',
    });
  });

  it('prefers an explicit code column over the name', () => {
    expect(effectiveIdentity({ code: 'LCP-006', name: 'Panorama Mall RYD' })).toEqual({
      code: 'LCP-006',
      name: 'Panorama Mall RYD',
    });
  });

  it('leaves a genuinely codeless branch codeless', () => {
    expect(effectiveIdentity({ code: null, name: '7 Days Plaza' })).toEqual({
      code: '',
      name: '7 Days Plaza',
    });
  });
});

describe('storeKey', () => {
  it('treats the split and unsplit spellings of one store as the same store', () => {
    // This is the case that produced duplicates: the sheet packs the code into
    // the name, the stored row has it in its own column.
    expect(storeKey({ code: null, name: 'LCP-006 Panorama Mall' })).toBe(
      storeKey({ code: 'LCP-006', name: 'Panorama Mall RYD' }),
    );
  });

  it('ignores name drift entirely when a code is present', () => {
    expect(storeKey({ code: 'LCP-006', name: 'Panorama Mall' })).toBe(
      storeKey({ code: 'lcp058'.replace('058', '006'), name: 'Totally Renamed' }),
    );
  });

  it('keeps different codes apart', () => {
    expect(storeKey({ code: 'LCP-006', name: 'X' })).not.toBe(
      storeKey({ code: 'LCP-007', name: 'X' }),
    );
  });

  it('scopes the codeless name fallback by brand', () => {
    // "Buhairah Plaza" exists for three brands in this master. Without the
    // brand scope, importing PSK's branch would be skipped as "already
    // present" because LCP's branch of the same name exists — and the branch
    // would be missing from every later report.
    const lcp = storeKey({ code: null, name: 'Buhairah Plaza', brandCode: 'LCP' });
    const psk = storeKey({ code: null, name: 'Buhairah Plaza', brandCode: 'PSK' });
    expect(lcp).not.toBe(psk);
  });

  it('matches a codeless row to itself across spellings', () => {
    expect(storeKey({ code: null, name: '7 Days  Plaza', brandCode: 'LCP' })).toBe(
      storeKey({ code: null, name: '7 days plaza', brandCode: 'lcp' }),
    );
  });
});

describe('brandKey', () => {
  it('matches on code regardless of case', () => {
    expect(brandKey({ code: 'lcp', name: 'Casa Pasta' })).toBe(
      brandKey({ code: 'LCP', name: 'Something Else' }),
    );
  });

  it('falls back to the name when there is no code', () => {
    expect(brandKey({ code: '', name: 'Casa Pasta' })).toBe(
      brandKey({ code: null, name: 'casa  pasta' }),
    );
  });
});

describe('partitionNew — the three import scenarios', () => {
  const row = (code: string | null, name: string, brandCode?: string) => ({
    code,
    name,
    brandCode,
  });
  const key = (r: { code: string | null; name: string; brandCode?: string }) => storeKey(r);

  it('fresh import: every row is new', () => {
    const incoming = [row('LCP-001', 'A'), row('LCP-002', 'B'), row('LCP-003', 'C')];
    const { fresh, alreadyPresent } = partitionNew(incoming, [], key);
    expect(fresh).toHaveLength(3);
    expect(alreadyPresent).toBe(0);
  });

  it('re-import of the identical file: nothing is added', () => {
    const incoming = [row('LCP-001', 'A'), row('LCP-002', 'B'), row('LCP-003', 'C')];
    const existing = incoming.map(key);
    const { fresh, alreadyPresent } = partitionNew(incoming, existing, key);
    expect(fresh).toEqual([]);
    expect(alreadyPresent).toBe(3);
  });

  it('mixed file: only the new rows are added, in order', () => {
    const existing = [row('LCP-001', 'A'), row('LCP-002', 'B')].map(key);
    const incoming = [
      row('LCP-001', 'A'), // known
      row('LCP-009', 'New One'), // new
      row('LCP-002', 'B'), // known
      row('LCP-010', 'New Two'), // new
    ];
    const { fresh, alreadyPresent } = partitionNew(incoming, existing, key);
    expect(fresh.map((r) => r.code)).toEqual(['LCP-009', 'LCP-010']);
    expect(alreadyPresent).toBe(2);
  });

  it('re-import still skips when the sheet spells the code the other way', () => {
    // Stored as code + name; re-uploaded with the code inside the name.
    const existing = [storeKey({ code: 'LCP-058', name: 'ARAMCO' })];
    const { fresh, alreadyPresent } = partitionNew([row(null, 'LCP058-ARAMCO')], existing, key);
    expect(fresh).toEqual([]);
    expect(alreadyPresent).toBe(1);
  });

  it('collapses a row the uploaded file itself lists twice', () => {
    // Otherwise the very first import is already not repeatable.
    const incoming = [row('LCP-001', 'A'), row('LCP-001', 'A again'), row('LCP-002', 'B')];
    const { fresh, alreadyPresent } = partitionNew(incoming, [], key);
    expect(fresh.map((r) => r.code)).toEqual(['LCP-001', 'LCP-002']);
    expect(alreadyPresent).toBe(1);
  });

  it('never reports more rows than it was given', () => {
    const incoming = [row('LCP-001', 'A'), row('LCP-002', 'B'), row('LCP-001', 'A')];
    const { fresh, alreadyPresent } = partitionNew(incoming, [], key);
    expect(fresh.length + alreadyPresent).toBe(incoming.length);
  });
});
