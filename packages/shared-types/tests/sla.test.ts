import { describe, it, expect } from 'vitest';
import {
  businessHoursSummary,
  pickSlaPolicy,
  policyCovers,
  scopeSpecificity,
  scopeSummary,
  type SlaPolicyScope,
} from '../src/sla.js';

/** A ticket that could match anything, so each test narrows only what it means to. */
const TICKET = {
  priority: 'high',
  complaintType: 'Late order',
  complaintSource: 'Comp. WhatsApp',
  brandName: 'Herfy',
};

function policy(id: string, scope: SlaPolicyScope, name = id) {
  return { id, name, ...scope };
}

describe('policyCovers', () => {
  it('covers a ticket that matches the one dimension the policy names', () => {
    expect(policyCovers({ applies_to_priority: ['high', 'urgent'] }, TICKET)).toBe(true);
  });

  it('does not cover a ticket that misses any named dimension', () => {
    expect(
      policyCovers({ applies_to_priority: ['high'], applies_to_brand: ['Kudu'] }, TICKET),
    ).toBe(false);
  });

  it('ignores dimensions the policy leaves empty', () => {
    expect(
      policyCovers(
        { applies_to_priority: ['high'], applies_to_type: [], applies_to_brand: null },
        TICKET,
      ),
    ).toBe(true);
  });

  /*
   * The bug that kept the whole feature silent: the compensation clone ships
   * active policies carrying no coverage at all. Reading those as "governs
   * everything" would put every ticket under a promise nobody wrote.
   */
  it('covers nothing when the policy names no dimension at all', () => {
    expect(policyCovers({}, TICKET)).toBe(false);
    expect(policyCovers({ applies_to_priority: null, applies_to_type: [] }, TICKET)).toBe(false);
  });

  it('does not cover a ticket whose value for a tested dimension is missing', () => {
    expect(
      policyCovers({ applies_to_type: ['Late order'] }, { ...TICKET, complaintType: null }),
    ).toBe(false);
  });

  it('treats a non-array coverage value as naming nothing', () => {
    // Directus hands back whatever is in the JSON column; a string there used
    // to reach `.includes` and match by substring.
    expect(policyCovers({ applies_to_priority: 'high' as never }, TICKET)).toBe(false);
  });
});

describe('scopeSpecificity', () => {
  it('counts the dimensions a policy actually narrows by', () => {
    expect(scopeSpecificity({})).toBe(0);
    expect(scopeSpecificity({ applies_to_priority: ['high'], applies_to_type: [] })).toBe(1);
    expect(scopeSpecificity({ applies_to_priority: ['high'], applies_to_brand: ['Herfy'] })).toBe(
      2,
    );
  });
});

describe('pickSlaPolicy', () => {
  it('returns null when nothing covers the ticket', () => {
    expect(pickSlaPolicy([policy('a', { applies_to_priority: ['low'] })], TICKET)).toBeNull();
  });

  it('prefers the more specific policy over the broader one', () => {
    const broad = policy('broad', { applies_to_priority: ['high'] });
    const narrow = policy('narrow', {
      applies_to_priority: ['high'],
      applies_to_brand: ['Herfy'],
    });
    expect(pickSlaPolicy([broad, narrow], TICKET).id).toBe('narrow');
    // Row order must not decide which promise a ticket is held to.
    expect(pickSlaPolicy([narrow, broad], TICKET).id).toBe('narrow');
  });

  it('breaks ties the same way every sweep', () => {
    const a = policy('id-2', { applies_to_priority: ['high'] }, 'Aardvark');
    const b = policy('id-1', { applies_to_priority: ['high'] }, 'Zebra');
    expect(pickSlaPolicy([a, b], TICKET).id).toBe('id-2');
    expect(pickSlaPolicy([b, a], TICKET).id).toBe('id-2');
  });
});

describe('scopeSummary', () => {
  it('lists one phrase per named dimension, and nothing for an empty policy', () => {
    expect(scopeSummary({ applies_to_priority: ['high', 'urgent'], applies_to_type: [] })).toEqual([
      'high, urgent',
    ]);
    expect(scopeSummary({})).toEqual([]);
  });
});

describe('businessHoursSummary', () => {
  const week = (open: number[], window: [string, string] = ['09:00', '17:00']) =>
    Object.fromEntries(
      [0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), open.includes(d) ? [window] : []]),
    );

  it('reads null as round-the-clock (no summary to show)', () => {
    expect(businessHoursSummary(null)).toBeNull();
  });

  it('collapses a contiguous, uniform week into a range', () => {
    expect(businessHoursSummary({ timezone: 'Asia/Riyadh', days: week([0, 1, 2, 3, 4]) })).toBe(
      'Sun-Thu 09:00-17:00',
    );
  });

  it('lists the days when they are not contiguous', () => {
    expect(businessHoursSummary({ timezone: 'UTC', days: week([0, 2, 4]) })).toBe(
      'Sun, Tue, Thu 09:00-17:00',
    );
  });

  it('says "Every day" rather than Sun-Sat', () => {
    expect(businessHoursSummary({ timezone: 'UTC', days: week([0, 1, 2, 3, 4, 5, 6]) })).toBe(
      'Every day 09:00-17:00',
    );
  });

  it('drops the window when the days do not share one', () => {
    const days = { ...week([0, 1]), '1': [['10:00', '14:00'] as [string, string]] };
    expect(businessHoursSummary({ timezone: 'UTC', days })).toBe('Sun-Mon');
  });

  /* An hours object with every day closed is the shape that makes the worker's
   * deadline maths throw. Summarising it as null keeps the card honest rather
   * than printing an empty range. */
  it('returns null when no day is open', () => {
    expect(businessHoursSummary({ timezone: 'UTC', days: week([]) })).toBeNull();
  });
});
