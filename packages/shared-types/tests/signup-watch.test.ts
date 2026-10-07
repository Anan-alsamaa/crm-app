import { describe, it, expect } from 'vitest';
import { signupCheck, signupCheckInterval, SIGNUP_WAIT_MAX_MS } from '../src/signup-watch.js';

/** The schedule the owner agreed for coupons held until signup (EMA-49). */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date('2026-10-07T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('signupCheckInterval', () => {
  it('is 10 minutes on the first day, hourly for a week, then daily', () => {
    expect(signupCheckInterval(0)).toBe(10 * MIN);
    expect(signupCheckInterval(DAY - 1)).toBe(10 * MIN);
    expect(signupCheckInterval(DAY)).toBe(HOUR);
    expect(signupCheckInterval(7 * DAY - 1)).toBe(HOUR);
    expect(signupCheckInterval(7 * DAY)).toBe(DAY);
  });
});

describe('signupCheck', () => {
  it('is due when never checked', () => {
    expect(signupCheck({ awaitingSince: ago(HOUR), lastChecked: null, validTo: null, now })).toBe(
      'due',
    );
  });

  it('waits until the interval for its age has passed', () => {
    const base = { awaitingSince: ago(2 * HOUR), validTo: null, now };
    expect(signupCheck({ ...base, lastChecked: ago(9 * MIN) })).toBe('wait');
    expect(signupCheck({ ...base, lastChecked: ago(10 * MIN) })).toBe('due');
    const older = { awaitingSince: ago(3 * DAY), validTo: null, now };
    expect(signupCheck({ ...older, lastChecked: ago(59 * MIN) })).toBe('wait');
    expect(signupCheck({ ...older, lastChecked: ago(HOUR) })).toBe('due');
  });

  it('expires when the coupon can no longer be used', () => {
    expect(
      signupCheck({ awaitingSince: ago(DAY), lastChecked: ago(HOUR), validTo: ago(1), now }),
    ).toBe('expired');
  });

  it('expires after the maximum wait when the coupon has no end date', () => {
    expect(
      signupCheck({
        awaitingSince: ago(SIGNUP_WAIT_MAX_MS + 1),
        lastChecked: ago(2 * DAY),
        validTo: null,
        now,
      }),
    ).toBe('expired');
  });

  it('keeps checking a coupon whose end date is still ahead', () => {
    expect(
      signupCheck({
        awaitingSince: ago(DAY / 2),
        lastChecked: ago(20 * MIN),
        validTo: new Date(now.getTime() + DAY),
        now,
      }),
    ).toBe('due');
  });
});
