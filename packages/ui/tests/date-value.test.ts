import { describe, expect, it } from 'vitest';
import {
  displayToIso,
  isoToDisplay,
  joinDateTime,
  maskDateInput,
  splitDateTime,
} from '../src/dateValue.js';

/*
 * These rules are the reason the product can show dd/mm/yyyy at all — Chrome
 * will not render a native date input in anything but its own locale — so they
 * are tested directly rather than through a mounted field.
 */

describe('isoToDisplay', () => {
  it('turns an ISO date into dd/mm/yyyy', () => {
    expect(isoToDisplay('2026-08-21')).toBe('21/08/2026');
  });

  it('keeps both parts zero-padded so a column of dates aligns', () => {
    expect(isoToDisplay('2026-01-05')).toBe('05/01/2026');
  });

  it('returns empty for the empty cases rather than "Invalid Date"', () => {
    expect(isoToDisplay('')).toBe('');
    expect(isoToDisplay(null)).toBe('');
    expect(isoToDisplay(undefined)).toBe('');
    expect(isoToDisplay('not-a-date')).toBe('');
  });
});

describe('displayToIso', () => {
  it('turns dd/mm/yyyy back into ISO', () => {
    expect(displayToIso('21/08/2026')).toBe('2026-08-21');
  });

  it('reads the FIRST group as the day — the whole point of the exercise', () => {
    // Under the browser's mm/dd reading this same string is either invalid or
    // a different date. 08 must be the month.
    expect(displayToIso('03/04/2026')).toBe('2026-04-03');
  });

  it('rejects a well-shaped date that does not exist', () => {
    // Date() rolls this into March rather than refusing it, so the round-trip
    // check is what catches it.
    expect(displayToIso('31/02/2026')).toBeNull();
    expect(displayToIso('31/04/2026')).toBeNull();
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(displayToIso('29/02/2024')).toBe('2024-02-29');
    expect(displayToIso('29/02/2026')).toBeNull();
  });

  it('rejects out-of-range parts', () => {
    expect(displayToIso('00/08/2026')).toBeNull();
    expect(displayToIso('21/13/2026')).toBeNull();
  });

  it('rejects partial input, so half-typed dates never reach the caller', () => {
    expect(displayToIso('')).toBeNull();
    expect(displayToIso('21')).toBeNull();
    expect(displayToIso('21/0')).toBeNull();
    expect(displayToIso('21/08/202')).toBeNull();
  });

  it('round-trips with isoToDisplay', () => {
    for (const iso of ['2026-08-21', '2024-02-29', '2026-01-01', '2026-12-31']) {
      expect(displayToIso(isoToDisplay(iso))).toBe(iso);
    }
  });
});

describe('maskDateInput', () => {
  it('inserts the separators as the user types digits', () => {
    expect(maskDateInput('2')).toBe('2');
    expect(maskDateInput('21')).toBe('21');
    expect(maskDateInput('210')).toBe('21/0');
    expect(maskDateInput('2108')).toBe('21/08');
    expect(maskDateInput('21082')).toBe('21/08/2');
    expect(maskDateInput('21082026')).toBe('21/08/2026');
  });

  it('treats typed and pasted dates identically', () => {
    expect(maskDateInput('21/08/2026')).toBe('21/08/2026');
    expect(maskDateInput('21082026')).toBe('21/08/2026');
  });

  it('drops anything that is not a digit', () => {
    expect(maskDateInput('21-08-2026')).toBe('21/08/2026');
    expect(maskDateInput('abc21x08y2026')).toBe('21/08/2026');
  });

  it('stops at eight digits so overtyping cannot run past the year', () => {
    expect(maskDateInput('2108202699')).toBe('21/08/2026');
  });

  it('does not re-add a separator the user just backspaced over', () => {
    // "21/" minus the slash is "21" — masking it again must stay "21", or the
    // caret gets trapped behind a slash that keeps reappearing.
    expect(maskDateInput('21')).toBe('21');
    expect(maskDateInput('21/08')).toBe('21/08');
  });

  it('clears to empty', () => {
    expect(maskDateInput('')).toBe('');
  });
});

/*
 * The datetime halves behind `DateTimeField`. A native `datetime-local` has the
 * same locale problem as a native date input, so the date half is ours and the
 * time half is not — these rules are what keep the value crossing the boundary
 * identical to what the native control emitted.
 */
describe('splitDateTime', () => {
  it('splits a datetime into its halves', () => {
    expect(splitDateTime('2026-08-21T14:30')).toEqual({ date: '2026-08-21', time: '14:30' });
  });

  it('drops seconds, so the field never re-emits precision it cannot show', () => {
    expect(splitDateTime('2026-08-21T14:30:59')).toEqual({ date: '2026-08-21', time: '14:30' });
  });

  it('reads a bare date as having no time yet', () => {
    expect(splitDateTime('2026-08-21')).toEqual({ date: '2026-08-21', time: '' });
  });

  it('treats empty and nullish alike', () => {
    expect(splitDateTime('')).toEqual({ date: '', time: '' });
    expect(splitDateTime(null)).toEqual({ date: '', time: '' });
    expect(splitDateTime(undefined)).toEqual({ date: '', time: '' });
  });
});

describe('joinDateTime', () => {
  it('joins both halves', () => {
    expect(joinDateTime('2026-08-21', '14:30')).toBe('2026-08-21T14:30');
  });

  it('completes a date with no time to midnight', () => {
    expect(joinDateTime('2026-08-21', '')).toBe('2026-08-21T00:00');
  });

  it('clears when both halves are empty', () => {
    expect(joinDateTime('', '')).toBe('');
  });

  it('holds a time with no date rather than emitting half a value', () => {
    // null means "not an answer yet" — the caller keeps it on screen and does
    // not push it upstream, where it would store or query against nonsense.
    expect(joinDateTime('', '14:30')).toBeNull();
  });
});
