import { describe, it, expect } from 'vitest';
import {
  buildStoreIndex,
  matchStore,
  normaliseRestaurantName,
  normaliseBrandName,
  cityFromRestaurantName,
  isUnmappedStore,
  splitStoreCode,
  storeCodeFrom,
  toStoreSnapshot,
  resolveStoreAttribution,
  planStoreSnapshotBackfill,
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

describe('matchStore — the store_code tier', () => {
  /**
   * Real case from the operations complaints history: the sheet writes
   * "LCP-006 Panorama Mall", the store master writes "LCP-006 Panorama Mall
   * RYD". Both name tiers miss on the city suffix, so before this tier five
   * complaints were reported as an unmapped store that plainly exists.
   */
  const PANORAMA: StoreRecord = {
    id: 's3',
    code: 'LCP-006',
    name: 'Panorama Mall RYD',
    city: 'Riyadh',
    areaManager: "Mo'men Elsharkasy",
    chainManager: 'Medhat Sayed',
    brandCode: 'LCP',
    brandName: 'Casa Pasta',
    yijiRestaurantId: null,
  };
  const idx = buildStoreIndex([PANORAMA]);

  it('recovers a store whose name drifted but whose code did not', () => {
    const m = matchStore(idx, { restaurantName: 'LCP-006 Panorama Mall', brandName: 'LCP' });
    expect(m.via).toBe('store_code');
    expect(m.store?.id).toBe('s3');
    expect(m.city).toBe('Riyadh');
    expect(m.chainManager).toBe('Medhat Sayed');
    // Reported under the master's spelling once matched.
    expect(m.restaurantName).toBe('LCP-006 Panorama Mall RYD');
    expect(isUnmappedStore(m)).toBe(false);
  });

  it('reads the code in all four spellings the master uses', () => {
    for (const written of [
      'LCP-006 Panorama Mall',
      'LCP- 006 Panorama Mall',
      'LCP006-Panorama Mall',
      'LCP.006 - Panorama Mall',
    ]) {
      expect(matchStore(idx, { restaurantName: written }).store?.id).toBe('s3');
    }
  });

  it('never outranks a name match — existing rows keep matching as they did', () => {
    // "CND-001 Reine Plaza" is an exact name hit AND carries a code. The name
    // tier must still win, or every dashboard's `via` breakdown shifts.
    expect(matchStore(index, { restaurantName: 'CND-001 Reine Plaza' }).via).toBe('exact_name');
    expect(matchStore(index, { restaurantName: 'Riyadh - Masief Plaza' }).via).toBe(
      'normalised_name',
    );
  });

  it('refuses to guess when one code names two stores', () => {
    // A duplicated code means the master is broken. Picking whichever row
    // loaded first would attribute complaints to an arbitrary branch, so the
    // code resolves to nothing and the brand fallback takes over.
    const clash: StoreRecord = { ...PANORAMA, id: 's4', name: 'Somewhere Else', city: 'Jeddah' };
    const broken = buildStoreIndex([PANORAMA, clash]);
    expect(broken.byCode.has('LCP-006')).toBe(false);
    const m = matchStore(broken, { restaurantName: 'LCP-006 Panorama Mall', brandName: 'LCP' });
    expect(m.store).toBeNull();
    expect(isUnmappedStore(m)).toBe(true);
  });

  it('does not invent a store from a branch name that merely looks like a code', () => {
    // "Mall 2 Riyadh" parses to "MALL-2", which is not in the master — so it
    // must fall through rather than resolve to anything.
    expect(matchStore(idx, { restaurantName: 'Mall 2 Riyadh' }).store).toBeNull();
  });

  it('still reports a genuinely absent store as unmapped', () => {
    // "CND-009 Nakhil Mall" — the one complaint in the history whose store is
    // missing from the master entirely. No tier may rescue this one.
    const m = matchStore(idx, { restaurantName: 'CND-009 Nakhil Mall', brandName: 'CND Casual' });
    expect(m.store).toBeNull();
    expect(isUnmappedStore(m)).toBe(true);
  });
});

describe('splitStoreCode', () => {
  it('normalises the four spellings to PREFIX-NNN', () => {
    expect(splitStoreCode('LCP-032 Masief Plaza')).toEqual({
      code: 'LCP-032',
      name: 'Masief Plaza',
    });
    expect(splitStoreCode('LCP- 089 Nada Plaza RYD')).toEqual({
      code: 'LCP-089',
      name: 'Nada Plaza RYD',
    });
    expect(splitStoreCode('LCP058-ARAMCO')).toEqual({ code: 'LCP-058', name: 'ARAMCO' });
    expect(splitStoreCode('LCP.073 - Amer Mall')).toEqual({ code: 'LCP-073', name: 'Amer Mall' });
  });

  it('leaves a plain branch name alone', () => {
    expect(splitStoreCode('Marina Mall 2')).toEqual({ code: null, name: 'Marina Mall 2' });
    expect(splitStoreCode('7 Days Plaza')).toEqual({ code: null, name: '7 Days Plaza' });
  });

  it('does not treat a bare code as a code — there would be no branch left', () => {
    expect(splitStoreCode('LCP-002')).toEqual({ code: null, name: 'LCP-002' });
  });

  it('survives nullish input', () => {
    expect(splitStoreCode(null)).toEqual({ code: null, name: '' });
    expect(storeCodeFrom(undefined)).toBe('');
  });
});

describe('store attribution is frozen onto the ticket, not re-derived', () => {
  /**
   * The requirement: editing a branch changes it FROM NOW ON. A report about
   * last quarter must still name whoever was responsible last quarter. If the
   * report re-resolved the store at render time, moving a branch to a new area
   * manager would silently reassign every complaint they never handled.
   */
  const BEFORE: StoreRecord = {
    id: 's1',
    code: 'LCP-041',
    name: 'Masief Plaza',
    city: 'Riyadh',
    areaManager: 'Ahmed Samir',
    chainManager: 'Medhat Sayed',
    brandCode: 'LCP',
    brandName: 'Casa Pasta',
    yijiRestaurantId: null,
  };
  /** The same branch after operations hand it to a different area manager. */
  const AFTER: StoreRecord = { ...BEFORE, areaManager: 'Khaled Abdellah' };

  const order = { restaurantName: 'LCP-041 Masief Plaza', brandName: 'Casa Pasta' };

  it('keeps the manager who was responsible when the ticket was raised', () => {
    // Ticket raised while Ahmed ran the area — attribution frozen then.
    const atCreation = matchStore(buildStoreIndex([BEFORE]), order);
    const frozen = toStoreSnapshot(atCreation, '2026-03-14T19:11:00.000Z');
    expect(frozen.areaManager).toBe('Ahmed Samir');

    // Months later the branch moves to Khaled. Reporting on the OLD ticket
    // must still say Ahmed.
    const laterIndex = buildStoreIndex([AFTER]);
    const { match, fromSnapshot } = resolveStoreAttribution(frozen, () =>
      matchStore(laterIndex, order),
    );
    expect(fromSnapshot).toBe(true);
    expect(match.areaManager).toBe('Ahmed Samir');

    // And the live lookup really would have said otherwise — proving the
    // snapshot is what protected the report, not a coincidence.
    expect(matchStore(laterIndex, order).areaManager).toBe('Khaled Abdellah');
  });

  it('freezes every reported store field, not just the manager', () => {
    const frozen = toStoreSnapshot(matchStore(buildStoreIndex([BEFORE]), order), 'ts');
    const renamed: StoreRecord = {
      ...BEFORE,
      name: 'Masief Plaza (Closed)',
      city: 'Jeddah',
      chainManager: 'Someone Else',
      brandName: 'Rebranded',
    };
    const { match } = resolveStoreAttribution(frozen, () =>
      matchStore(buildStoreIndex([renamed]), order),
    );
    expect(match.restaurantName).toBe('LCP-041 Masief Plaza');
    expect(match.city).toBe('Riyadh');
    expect(match.chainManager).toBe('Medhat Sayed');
    expect(match.brandName).toBe('Casa Pasta');
  });

  it('a NEW ticket after the change gets the new manager', () => {
    // The freeze must not stop legitimate change going forward.
    const atCreation = matchStore(buildStoreIndex([AFTER]), order);
    const frozen = toStoreSnapshot(atCreation, 'ts');
    expect(frozen.areaManager).toBe('Khaled Abdellah');
  });

  it('falls back to a live lookup only when there is no snapshot', () => {
    // Tickets raised before this existed have nothing frozen; they can only be
    // resolved live, and that is visible rather than pretended otherwise.
    const { match, fromSnapshot } = resolveStoreAttribution(null, () =>
      matchStore(buildStoreIndex([AFTER]), order),
    );
    expect(fromSnapshot).toBe(false);
    expect(match.areaManager).toBe('Khaled Abdellah');
  });

  it('remembers an unmapped store as unmapped, and how weakly it matched', () => {
    const miss = matchStore(buildStoreIndex([BEFORE]), {
      restaurantName: 'Jeddah - Nowhere',
      brandName: 'Casa Pasta',
    });
    const frozen = toStoreSnapshot(miss, 'ts');
    expect(frozen.storeId).toBeNull();
    expect(frozen.via).toBe('brand_only');
    const { match } = resolveStoreAttribution(frozen, () => {
      throw new Error('must not re-resolve');
    });
    expect(isUnmappedStore(match)).toBe(true);
    expect(match.via).toBe('brand_only');
  });

  it('ignores a malformed snapshot rather than reporting garbage', () => {
    for (const bad of [null, undefined]) {
      const { fromSnapshot } = resolveStoreAttribution(bad, () =>
        matchStore(buildStoreIndex([AFTER]), order),
      );
      expect(fromSnapshot).toBe(false);
    }
  });
});

describe('planStoreSnapshotBackfill — closing the gap for older tickets', () => {
  const STORE: StoreRecord = {
    id: 's1',
    code: 'LCP-041',
    name: 'Masief Plaza',
    city: 'Riyadh',
    areaManager: 'Ahmed Samir',
    chainManager: 'Medhat Sayed',
    brandCode: 'LCP',
    brandName: 'Casa Pasta',
    yijiRestaurantId: null,
  };
  const idx = buildStoreIndex([STORE]);
  const order = { restaurantName: 'LCP-041 Masief Plaza', brandName: 'Casa Pasta' };

  it('freezes a ticket that has an order but no snapshot', () => {
    const plan = planStoreSnapshotBackfill([{ id: 't1', storeSnapshot: null, order }], idx, 'now');
    expect(plan.toFreeze).toHaveLength(1);
    expect(plan.toFreeze[0]!.snapshot.areaManager).toBe('Ahmed Samir');
  });

  it('marks what it writes as backfilled, never passing it off as a real capture', () => {
    // These values are the store as it stands today, not as it stood when the
    // ticket was raised. Saying so is the difference between knowing and
    // assuming.
    const plan = planStoreSnapshotBackfill([{ id: 't1', storeSnapshot: null, order }], idx, 'now');
    expect(plan.toFreeze[0]!.snapshot.backfilled).toBe(true);
  });

  it('never overwrites a snapshot that already exists', () => {
    // An existing snapshot IS the historical record this change protects.
    const existing = toStoreSnapshot(matchStore(idx, order), 'earlier');
    const plan = planStoreSnapshotBackfill(
      [{ id: 't1', storeSnapshot: existing, order }],
      idx,
      'now',
    );
    expect(plan.toFreeze).toHaveLength(0);
    expect(plan.alreadyFrozen).toBe(1);
  });

  it('invents nothing for a ticket with no order to attribute', () => {
    const plan = planStoreSnapshotBackfill(
      [
        { id: 't1', storeSnapshot: null, order: null },
        { id: 't2', storeSnapshot: null, order: {} },
      ],
      idx,
      'now',
    );
    expect(plan.toFreeze).toHaveLength(0);
    expect(plan.noOrder).toBe(2);
  });

  it('still freezes an unmapped store, and counts it', () => {
    // Freezing "unmapped" is right: it is what the report said at the time, and
    // leaving it live would let a later store edit change the past.
    const plan = planStoreSnapshotBackfill(
      [{ id: 't1', storeSnapshot: null, order: { restaurantName: 'Jeddah - Nowhere' } }],
      idx,
      'now',
    );
    expect(plan.toFreeze).toHaveLength(1);
    expect(plan.unmapped).toBe(1);
    expect(plan.toFreeze[0]!.snapshot.storeId).toBeNull();
  });

  it('is a no-op on a second run', () => {
    const first = planStoreSnapshotBackfill([{ id: 't1', storeSnapshot: null, order }], idx, 'now');
    const applied = first.toFreeze.map((f) => ({
      id: f.id,
      storeSnapshot: f.snapshot,
      order,
    }));
    const second = planStoreSnapshotBackfill(applied, idx, 'later');
    expect(second.toFreeze).toHaveLength(0);
    expect(second.alreadyFrozen).toBe(1);
  });

  it('after a backfill, editing the store no longer moves the ticket', () => {
    // The whole point, end to end.
    const plan = planStoreSnapshotBackfill([{ id: 't1', storeSnapshot: null, order }], idx, 'now');
    const frozen = plan.toFreeze[0]!.snapshot;

    const moved = buildStoreIndex([{ ...STORE, areaManager: 'Khaled Abdellah' }]);
    const { match } = resolveStoreAttribution(frozen, () => matchStore(moved, order));
    expect(match.areaManager).toBe('Ahmed Samir');
  });

  it('accounts for every ticket it was given', () => {
    const plan = planStoreSnapshotBackfill(
      [
        { id: 'a', storeSnapshot: null, order },
        { id: 'b', storeSnapshot: toStoreSnapshot(matchStore(idx, order), 'x'), order },
        { id: 'c', storeSnapshot: null, order: null },
      ],
      idx,
      'now',
    );
    expect(plan.toFreeze.length + plan.alreadyFrozen + plan.noOrder).toBe(3);
  });
});
