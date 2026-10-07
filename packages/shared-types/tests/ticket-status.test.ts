import { describe, expect, it } from 'vitest';
import {
  normaliseTicketStatus,
  RETIRED_TICKET_STATUS,
  SOLVED_TICKET_STATUSES_STORED,
  TicketStatus,
  UNSOLVED_TICKET_STATUSES_STORED,
} from '../src/index.js';

/*
 * Two ticket states (owner, 2026-10-07): pending and solved, everywhere.
 * Stored rows are NOT migrated, so every retired value must still read as one
 * of the two.
 */
describe('TicketStatus', () => {
  it('is exactly pending and solved', () => {
    expect(TicketStatus.options).toEqual(['pending', 'solved']);
  });

  it.each([
    ['pending', 'pending'],
    ['open', 'pending'],
    ['new', 'pending'],
    ['solved', 'solved'],
    ['resolved', 'solved'],
    ['closed', 'solved'],
  ])('normalises a stored %s to %s', (raw, want) => {
    expect(normaliseTicketStatus(raw)).toBe(want);
  });

  it('reads an unknown or missing value as pending, never as solved', () => {
    expect(normaliseTicketStatus(null)).toBe('pending');
    expect(normaliseTicketStatus(undefined)).toBe('pending');
    expect(normaliseTicketStatus('')).toBe('pending');
    expect(normaliseTicketStatus('escalated')).toBe('pending');
  });

  it('maps every retired value onto the live two', () => {
    for (const v of Object.values(RETIRED_TICKET_STATUS)) {
      expect(TicketStatus.options).toContain(v);
    }
  });

  it('server-side filter lists cover every stored value, and agree with the normaliser', () => {
    for (const s of UNSOLVED_TICKET_STATUSES_STORED)
      expect(normaliseTicketStatus(s)).toBe('pending');
    for (const s of SOLVED_TICKET_STATUSES_STORED) expect(normaliseTicketStatus(s)).toBe('solved');
    const all = new Set<string>([
      ...UNSOLVED_TICKET_STATUSES_STORED,
      ...SOLVED_TICKET_STATUSES_STORED,
    ]);
    for (const k of Object.keys(RETIRED_TICKET_STATUS)) expect(all.has(k)).toBe(true);
  });
});
