import { describe, it, expect } from 'vitest';
import { couponEndpointFor, YIJI_COUPON_PATH } from '../src/processors/coupon-push.js';

/*
 * ONE PLATFORM TODAY, A ROW FOR THE NEXT ONE.
 *
 * The coupon path and its payload are coupled — a body shaped for Yiji's
 * endpoint means nothing to another one — so the two are declared together per
 * vendor rather than the URL being made configurable.
 *
 * These tests pin the behaviour that matters when a second vendor arrives:
 * a known vendor resolves, an unknown one resolves to NOTHING rather than to
 * Yiji, and today's rows (which predate vendors being distinguished) still go
 * where they always went.
 */
describe('couponEndpointFor', () => {
  it('routes vendor 1 (Yiji/EG) to the endpoint it has always used', () => {
    expect(couponEndpointFor('1')).toEqual({ path: YIJI_COUPON_PATH, platform: 'yiji' });
  });

  /* Every row written before vendors were distinguished carries no vendor.
     They are Yiji's, because Yiji was the only platform. */
  it.each([null, undefined, '', '   '])('treats %p as vendor 1', (v) => {
    expect(couponEndpointFor(v)).toEqual({ path: YIJI_COUPON_PATH, platform: 'yiji' });
  });

  /*
   * THE IMPORTANT ONE. An unrecognised vendor must not fall through to Yiji:
   * sending somebody else's coupon to the wrong platform is worse than not
   * sending it, and the push treats null as "not configured" — the request
   * stays `approved` and is visible rather than silently wrong.
   */
  it('refuses an unknown vendor instead of guessing', () => {
    expect(couponEndpointFor('2')).toBeNull();
    expect(couponEndpointFor('not-a-vendor')).toBeNull();
  });
});
