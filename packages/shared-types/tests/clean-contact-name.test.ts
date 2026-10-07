import { describe, expect, it } from 'vitest';
import { cleanContactName, displayContactName } from '../src/phone.js';

/*
 * The write-side rule (owner, 2026-10-07): a contact's NAME must not be its
 * phone number. The gateway used to copy Yiji's `fullName` straight in, so the
 * agent portal's header and sidebar read `+966508315325` where the inbox list
 * — through `displayContactName` — read `0508315325`.
 */
describe('cleanContactName', () => {
  it.each([
    ['+966508315325'],
    ['966508315325'],
    ['0508315325'],
    ['508315325'],
    ['+966564490993 - +966564490993'],
    ['  +966 50 831 5325  '],
  ])('a name that is only a phone number is no name: %s', (raw) => {
    expect(cleanContactName(raw)).toBeNull();
  });

  it('keeps the name and drops the number Yiji appends to it', () => {
    expect(cleanContactName('منيره - +966562088955')).toBe('منيره');
    expect(cleanContactName('Ahmed Ali – 0562088955')).toBe('Ahmed Ali');
  });

  it('leaves a real name with a dash in it alone', () => {
    expect(cleanContactName('Al - Harbi')).toBe('Al - Harbi');
    expect(cleanContactName('Ahmed')).toBe('Ahmed');
  });

  it('treats blanks and machine addresses as no name', () => {
    expect(cleanContactName(null)).toBeNull();
    expect(cleanContactName(undefined)).toBeNull();
    expect(cleanContactName('   ')).toBeNull();
    expect(cleanContactName('9665410950517557@yiji.com')).toBeNull();
  });

  it('does not make a foreign number into a name either', () => {
    expect(cleanContactName('+447700900123')).toBeNull();
  });
});

describe('displayContactName — numbers glued onto a name', () => {
  it('shows the name without the trailing number', () => {
    expect(displayContactName('منيره - +966562088955', '0562088955')).toBe('منيره');
  });

  it('reduces a doubled number to the canonical 05 form', () => {
    expect(displayContactName('+966564490993 - +966564490993', null)).toBe('0564490993');
  });
});
