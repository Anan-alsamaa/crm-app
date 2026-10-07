import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normaliseTicketStatus } from '@yiji/shared-types';

/**
 * THE TICKET STATUS FILTER COULD NOT SEE 99% OF TICKETS.
 *
 * Asked for by operations (EMA-31, Ayman, 2026-10-04): *"Need to add filter for
 * ticket status to show open one in user portal."*
 *
 * A status filter already existed. It appeared not to work, and the reason is
 * the request: the agent queue mapped `complaintStatus: t.status` RAW, while
 * the tiles compare against the canonical `open | pending | solved`.
 *
 * The stored value is deliberately NOT always canonical. `enums.ts` is explicit
 * that retired spellings are never rewritten in place — rewriting 1,671
 * imported `closed` rows would destroy the only record of what operations
 * actually filed. Every READER normalises instead. This one did not.
 *
 * MEASURED ON STAGING, which holds the imported history:
 *
 *     closed    1671   <- matched no tile
 *     new         13   <- matched no tile
 *     resolved     8   <- matched no tile
 *     open         2
 *     ------------------
 *     1,692 of 1,694 unfilterable — 99%.
 *
 * Production is clean TODAY (74 solved, 1 open) only because the historical
 * import has not landed; EMA-30 brings the same 1,671 `closed` rows with it.
 *
 * This is the codebase's recurring shape: a comparison that matches nothing and
 * renders as a plausible empty list.
 */

/** The exact distribution measured on staging, 2026-10-04. */
const STAGING = [
  { status: 'closed', count: 1671 },
  { status: 'new', count: 13 },
  { status: 'resolved', count: 8 },
  { status: 'open', count: 2 },
];

/** What a status tile does: compare against one canonical value. Two states
 *  now (owner, 2026-10-07): pending and solved. */
const TILES = ['pending', 'solved'] as const;

describe('every stored status reaches a filter tile', () => {
  it.each(STAGING)('$status is filterable once normalised', ({ status }) => {
    expect(TILES).toContain(normaliseTicketStatus(status));
  });

  /* THE REGRESSION, stated as the number it actually was. */
  it('leaves nothing unfilterable across the whole staging set', () => {
    const total = STAGING.reduce((n, r) => n + r.count, 0);
    const unfilterable = STAGING.filter(
      (r) => !(TILES as readonly string[]).includes(r.status),
    ).reduce((n, r) => n + r.count, 0);

    /* Raw: none of the 1,694 matches a tile — even `open` is retired now. */
    expect(unfilterable).toBe(1694);
    expect(total).toBe(1694);

    /* Normalised: none. */
    const stillUnfilterable = STAGING.filter(
      (r) => !(TILES as readonly string[]).includes(normaliseTicketStatus(r.status)),
    ).reduce((n, r) => n + r.count, 0);
    expect(stillUnfilterable).toBe(0);
  });

  /*
   * AND THE FOLDING IS THE DOCUMENTED ONE. `new` and `open` both only ever
   * meant "not done yet", so they are pending, not a third status.
   */
  it('folds the retired spellings the way enums.ts says', () => {
    expect(normaliseTicketStatus('new')).toBe('pending');
    expect(normaliseTicketStatus('open')).toBe('pending');
    expect(normaliseTicketStatus('closed')).toBe('solved');
    expect(normaliseTicketStatus('resolved')).toBe('solved');
  });

  /* An unknown or absent status is PENDING, not hidden: a ticket nobody can
     classify is still work somebody has to do. */
  it('never hides a ticket it cannot classify', () => {
    expect(normaliseTicketStatus(null)).toBe('pending');
    expect(normaliseTicketStatus('')).toBe('pending');
    expect(normaliseTicketStatus('something-nobody-expected')).toBe('pending');
  });
});

/**
 * AND THE TWO PORTALS MUST AGREE ABOUT ONE TICKET.
 *
 * The admin report normalised; the agent queue did not. The same ticket
 * therefore read as two different statuses depending on which screen you were
 * on — the fault the "two ticket reports must agree" rule exists to prevent.
 */
const AGENT = readFileSync(
  resolve(import.meta.dirname, '../src/features/complaints/api.ts'),
  'utf8',
);
const PAGE = readFileSync(
  resolve(import.meta.dirname, '../src/features/tickets/TicketsPage.tsx'),
  'utf8',
);

describe('the agent queue reads status the same way the admin report does', () => {
  it('normalises in the query', () => {
    expect(AGENT).toMatch(/complaintStatus: normaliseTicketStatus\(t\.status\)/);
  });

  /* THE REGRESSION: the raw passthrough. */
  it('no longer passes the stored value straight through', () => {
    expect(AGENT).not.toMatch(/complaintStatus: t\.status,/);
  });

  /*
   * AND THE PAGE DROPS ITS WORKAROUND. The KPI counted `open || new` while the
   * tile beside it counted with `filterCount`, which never knew about `new` —
   * so the two disagreed. With the query normalising, a second idea of "open"
   * is not a safety net, it is a bug waiting to diverge again.
   */
  it('counts pending without a second idea of what unfinished means', () => {
    expect(PAGE).toMatch(
      /const pending = list\.filter\(\(r\) => r\.complaintStatus === 'pending'\)\.length/,
    );
    expect(PAGE).not.toMatch(/r\.complaintStatus === 'new'/);
    expect(PAGE).not.toMatch(/r\.complaintStatus === 'open'/);
  });
});
