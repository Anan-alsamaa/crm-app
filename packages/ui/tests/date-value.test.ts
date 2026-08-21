import { describe, expect, it } from 'vitest';
import { displayToIso, isoToDisplay, maskDateInput } from '../src/dateValue.js';

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
