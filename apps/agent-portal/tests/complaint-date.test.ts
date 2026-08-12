import { describe, it, expect } from 'vitest';
import {
  complaintPatch,
  emptyComplaint,
  nowLocalInput,
  toDateInput,
} from '../src/features/tickets/ComplaintFields.js';

/**
 * The complaint date is the one field an agent cannot recover later if it is
 * stored wrong, and it is what every ops report groups by. These pin the two
 * ways it could silently go wrong: a timezone shift moving a complaint across
 * midnight, and a blank being stored as something other than "not answered".
 */

describe('complaint date', () => {
  it('stores what the agent typed, read as their local wall clock', () => {
    const patch = complaintPatch({ ...emptyComplaint, complaint_date: '2026-08-01T09:30' });
    // Whatever the machine's zone, 09:30 local is the instant stored — so
    // round-tripping it back into the form yields the same wall clock.
    expect(toDateInput(patch.complaint_date as string)).toBe('2026-08-01T09:30');
  });

  it('survives a round trip across the form and back', () => {
    const typed = '2026-01-31T23:45';
    const stored = complaintPatch({ ...emptyComplaint, complaint_date: typed })
      .complaint_date as string;
    // Late-evening times are where a UTC misreading shows up first: parsed
    // wrongly, this lands on 1 February in a positive-offset zone.
    expect(toDateInput(stored)).toBe(typed);
  });

  it('stores a blank date as null, not an empty string', () => {
    // An empty string is a value; reports would render it as its own category.
    expect(complaintPatch(emptyComplaint).complaint_date).toBeNull();
  });

  it('ignores an unparseable date rather than storing garbage', () => {
    expect(complaintPatch({ ...emptyComplaint, complaint_date: 'not a date' }).complaint_date).toBe(
      null,
    );
  });

  it('formats "now" the only way datetime-local accepts', () => {
    expect(nowLocalInput(new Date(2026, 7, 1, 9, 5))).toBe('2026-08-01T09:05');
  });

  it('treats a missing stored date as an empty field, not "Invalid Date"', () => {
    expect(toDateInput(null)).toBe('');
    expect(toDateInput('nonsense')).toBe('');
  });
});
