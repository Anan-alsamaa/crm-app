import { describe, it, expect } from 'vitest';
import { displayContactName } from '../src/phone.js';

/**
 * WHAT AN AGENT SEES WHERE THE CUSTOMER'S NAME GOES.
 *
 * Most customers have no name. They arrive from the app or a QR code, and what
 * lands in the `name` column is whatever the source happened to send — a phone
 * number in one of four shapes, or an address Yiji synthesised to register them
 * with. Neither is a name, and both reached the screen untouched.
 *
 * Two reports, one function:
 *
 *   2026-10-01 — a numeric name rendered in whatever shape it was stored, so
 *                one customer read two different ways on one screen and two
 *                customers with the same number looked like different people.
 *   2026-10-04 — *"still shows email in agent portal"*. Yiji registers app
 *                customers against a synthesised address, so the live
 *                late-orders queue is full of `176732564464481@AFCO.com` and
 *                `9665410950517557@yiji.com`. An agent needs the MOBILE: it is
 *                what they dial, WhatsApp, address a coupon by and paste into
 *                Yiji to find the order.
 *
 * DISPLAY ONLY. Nothing is written back; this makes every surface agree about
 * what is already in the database.
 */

describe('a real name is left alone', () => {
  it.each([
    ['Ahmed', 'Ahmed'],
    ['Hessah Abdullah', 'Hessah Abdullah'],
    ['محمد العتيبي', 'محمد العتيبي'],
  ])('%s stays %s', (input, expected) => {
    expect(displayContactName(input, '0501234567')).toBe(expected);
  });

  /* Trimmed, because a name padded with spaces is the same name. */
  it('trims surrounding whitespace', () => {
    expect(displayContactName('  Ahmed  ', '0501234567')).toBe('Ahmed');
  });
});

describe('a name that is really a phone number', () => {
  /* Every shape the sources used, resolved to the one canonical form. */
  it.each([
    ['+966564490993', '0564490993'],
    ['966564490993', '0564490993'],
    ['509040892', '0509040892'],
    ['0509040892', '0509040892'],
  ])('%s renders as %s', (input, expected) => {
    expect(displayContactName(input, null)).toBe(expected);
  });

  /* A FOREIGN number must not be made to look Saudi — prefixing a 0 onto a UAE
     number invents a customer who does not exist. */
  it('leaves a foreign number as it was', () => {
    expect(displayContactName('+971501234567', null)).toBe('+971501234567');
  });
});

describe('a machine address is not a name', () => {
  /*
   * THE 2026-10-04 REPORT. These are the exact shapes measured on the live
   * late-orders queue.
   */
  it.each([
    ['176732564464481@AFCO.com', '0564464481'],
    ['9665410950517557@yiji.com', '0541095051'],
    ['hasoos.als11@gmail.com', '0590785067'],
  ])('%s falls back to the phone', (name, phone) => {
    expect(displayContactName(name, phone)).toBe(phone);
  });

  /* The phone is NORMALISED on the way out, so the fallback cannot reintroduce
     the four-shapes problem the other half of this function exists to fix. */
  it('normalises the phone it falls back to', () => {
    expect(displayContactName('x@yiji.com', '+966564464481')).toBe('0564464481');
  });

  /*
   * WITH NO PHONE, THE ADDRESS IS BETTER THAN NOTHING. It is at least an
   * identifier, and a blank cell tells the agent less than a machine address
   * does.
   */
  it('shows the address when there is no phone at all', () => {
    expect(displayContactName('9665410950517557@yiji.com', null)).toBe('9665410950517557@yiji.com');
    expect(displayContactName('9665410950517557@yiji.com', '')).toBe('9665410950517557@yiji.com');
  });

  /*
   * AND THE TEST STAYS NARROW. A real name containing an `@` is not a thing,
   * but a nickname might be — requiring a dot-suffix after the `@` keeps
   * "a@b" out of this.
   */
  it('does not treat a bare at-sign as an address', () => {
    expect(displayContactName('a@b', '0501234567')).toBe('a@b');
    expect(displayContactName('@handle', '0501234567')).toBe('@handle');
  });
});

describe('no name at all', () => {
  it('falls back to the normalised phone', () => {
    expect(displayContactName(null, '+966564490993')).toBe('0564490993');
    expect(displayContactName('', '0564490993')).toBe('0564490993');
    expect(displayContactName('   ', '0564490993')).toBe('0564490993');
  });

  /* Nothing known at all is an empty string, for the caller to replace with
     whatever "unknown customer" reads as in their surface. */
  it('answers empty when there is nothing to show', () => {
    expect(displayContactName(null, null)).toBe('');
    expect(displayContactName(undefined, undefined)).toBe('');
  });
});
