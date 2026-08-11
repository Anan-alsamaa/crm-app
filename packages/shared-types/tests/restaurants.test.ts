import { describe, it, expect } from 'vitest';
import {
  buildStoreIndex,
  matchStore,
  normaliseRestaurantName,
  normaliseBrandName,
  cityFromRestaurantName,
  isUnmappedStore,
  type StoreRecord,
} from '../src/restaurants.js';

/**
 * The fixtures below are REAL values, not invented ones: the Yiji side comes
 * from order 946641 captured on 2026-08-10 (note the leading space Yiji ships
 * on brandName), and the store side from the operations sheet.
 */
const LCP_MASIEF: StoreRecord = {
  id: 's1',
  code: 'LCP-041',
  name: 'Masief Plaza',
  city: 'Riyadh',
  areaManager: 'Ahmed Samir',
  chainManager: "Mo'men Elsharkawy",
  brandCode: 'LCP',
  brandName: 'La Casa Pasta',
  yijiRestaurantId: null,
};

const CND_REINE: StoreRecord = {
  id: 's2',
  code: 'CND-001',
  name: 'Reine Plaza',
  city: 'Khobar',
  areaManager: 'Aly AbdulRahman',
  chainManager: 'Aly AbdulRahman',
  brandCode: 'CND',
  brandName: 'CND Express',
  yijiRestaurantId: '312',
};

const index = buildStoreIndex([LCP_MASIEF, CND_REINE]);

describe('normaliseRestaurantName', () => {
  it('strips the ops store-code prefix', () => {
    expect(normaliseRestaurantName('LCP-002 Marina Mall 2')).toBe('marina mall 2');
    expect(normaliseRestaurantName('CND-001 Reine Plaza')).toBe('reine plaza');
  });

  it("strips Yiji's '<city> - ' branch prefix", () => {
    expect(normaliseRestaurantName('Riyadh - Masief Plaza')).toBe('masief plaza');
  });

  it('keeps hyphenated place names intact (only a SPACED hyphen splits)', () => {
    // "Al-Nakheel" must not lose its first half to the city split.
    expect(normaliseRestaurantName('Al-Nakheel Mall')).toBe('al nakheel mall');
  });

  it('is case, spacing and punctuation insensitive', () => {
    expect(normaliseRestaurantName('  MASIEF   plaza. ')).toBe('masief plaza');
  });

  it('returns empty for nullish input', () => {
    expect(normaliseRestaurantName(null)).toBe('');
    expect(normaliseRestaurantName(undefined)).toBe('');
  });
});

describe('normaliseBrandName', () => {
  it('tolerates the leading space Yiji actually sends', () => {
    expect(normaliseBrandName(' La Casa Pasta')).toBe('la casa pasta');
    expect(normaliseBrandName('La Casa Pasta')).toBe('la casa pasta');
  });
});

describe('cityFromRestaurantName', () => {
  it('recovers the city Yiji embeds in the branch name', () => {
    expect(cityFromRestaurantName('Riyadh - Masief Plaza')).toBe('Riyadh');
  });

  it('is empty when there is no city prefix', () => {
    expect(cityFromRestaurantName('Marina Mall 2')).toBe('');
  });
});

describe('matchStore', () => {
  it('matches the REAL order 946641 payload to the ops store row', () => {
    const m = matchStore(index, {
      brandName: ' La Casa Pasta',
      restaurantName: 'Riyadh - Masief Plaza',
    });
    expect(m.via).toBe('normalised_name');
    expect(m.store?.id).toBe('s1');
    expect(m.brandName).toBe('La Casa Pasta');
    expect(m.city).toBe('Riyadh');
    expect(m.areaManager).toBe('Ahmed Samir');
    expect(m.chainManager).toBe("Mo'men Elsharkawy");
    expect(m.restaurantName).toBe('LCP-041 Masief Plaza');
    expect(isUnmappedStore(m)).toBe(false);
  });

  it('prefers the Yiji restaurant id over any name heuristic', () => {
    const m = matchStore(index, {
      restaurantId: '312',
      // Deliberately a name that would NOT match, to prove the id wins.
      restaurantName: 'Somewhere Else Entirely',
      brandName: 'Whatever',
    });
    expect(m.via).toBe('yiji_id');
    expect(m.store?.id).toBe('s2');
    expect(m.city).toBe('Khobar');
  });

  it('matches on the exact full name including the code', () => {
    const m = matchStore(index, { restaurantName: 'CND-001 Reine Plaza' });
    expect(m.via).toBe('exact_name');
    expect(m.store?.id).toBe('s2');
  });

  it('matches the brand by its ORDER-SYSTEM alias, not just the display name', () => {
    // Operations call it "Casa Pasta"; Yiji sends "La Casa Pasta". Without
    // indexing the alias this silently returns via:'none' and the ticket drops
    // out of the brand ranking — and only for branches missing from the store
    // list, which is precisely when the fallback is meant to help.
    const opsWording: StoreRecord = {
      ...LCP_MASIEF,
      brandName: 'Casa Pasta',
      brandYijiName: 'La Casa Pasta',
    };
    const idx = buildStoreIndex([opsWording]);
    const m = matchStore(idx, {
      restaurantName: 'Riyadh - A Branch Not In The Sheet',
      brandName: ' La Casa Pasta',
    });
    expect(m.via).toBe('brand_only');
    // Reported under the wording operations use, not Yiji's.
    expect(m.brandName).toBe('Casa Pasta');
  });

  it('falls back to brand-only when the branch is unknown', () => {
    const m = matchStore(index, {
      restaurantName: 'Riyadh - A Brand New Branch',
      brandName: 'La Casa Pasta',
    });
    expect(m.via).toBe('brand_only');
    expect(m.store).toBeNull();
    expect(m.brandName).toBe('La Casa Pasta');
    // The city Yiji embedded is still recovered even with no store row.
    expect(m.city).toBe('Riyadh');
    expect(isUnmappedStore(m)).toBe(true);
  });

  it('keeps the order values when nothing matches at all', () => {
    const m = matchStore(index, {
      restaurantName: 'Jeddah - Unknown Place',
      brandName: 'Unknown Brand',
    });
    expect(m.via).toBe('none');
    // Losing the real restaurant name would make the report WORSE than before
    // the mapping existed, so unmatched rows still carry what Yiji told us.
    expect(m.restaurantName).toBe('Jeddah - Unknown Place');
    expect(m.brandName).toBe('Unknown Brand');
    expect(m.city).toBe('Jeddah');
  });

  it('handles a missing / empty order without throwing', () => {
    expect(matchStore(index, null).via).toBe('none');
    expect(matchStore(index, {}).via).toBe('none');
    expect(matchStore(index, { restaurantName: '' }).via).toBe('none');
  });

  it('does not let a duplicate row silently replace an earlier one', () => {
    const dup: StoreRecord = { ...LCP_MASIEF, id: 'dupe', city: 'WRONG CITY' };
    const idx = buildStoreIndex([LCP_MASIEF, dup]);
    const m = matchStore(idx, { restaurantName: 'Riyadh - Masief Plaza' });
    expect(m.store?.id).toBe('s1');
    expect(m.city).toBe('Riyadh');
  });
});
