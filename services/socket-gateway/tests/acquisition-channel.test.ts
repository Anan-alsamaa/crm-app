import { describe, it, expect } from 'vitest';
import { acquisitionChannel } from '../src/directus.js';

/**
 * THREE ways a customer reaches us, not two.
 *
 * This used to be `claims.walk_in ? 'walk_in' : 'app'` — one boolean answering
 * two independent questions. The door they came through and whether they hold a
 * Yiji account are not the same fact, and conflating them lost the case the
 * owner actually wanted (2026-09-13): an app customer STANDING IN A BRANCH
 * proved their account, so `walk_in` was false, so they were filed as `app` and
 * became indistinguishable from a customer at home. "How many of our app
 * customers visit the shops?" could not be asked at all.
 *
 * These pin all three, and the backward-compatible default, because the failure
 * was silent — a plausible value in the column, just the wrong one.
 */
describe('which of the three doors a customer came through', () => {
  it('app customer at home -> app', () => {
    // Opened inside the Yiji app: no store entry point, account proven.
    expect(acquisitionChannel({ walk_in: false, entry_point: 'app' })).toBe('app');
  });

  it('app customer standing in a branch -> walk_in_app', () => {
    // THE CASE THAT DID NOT EXIST. Scanned the branch QR code and proved a Yiji
    // account, so `walk_in` is false — which previously filed them as `app`.
    expect(acquisitionChannel({ walk_in: false, entry_point: 'store_qr' })).toBe('walk_in_app');
  });

  it('customer in a branch with no Yiji account -> walk_in', () => {
    expect(acquisitionChannel({ walk_in: true, entry_point: 'store_qr' })).toBe('walk_in');
  });

  it('a token minted before entry_point existed still files as app', () => {
    /*
     * BACKWARD COMPATIBILITY, and it is load-bearing. Tokens live two hours, so
     * sessions signed by the previous build are still arriving after a deploy.
     * Without `entry_point` the only honest reading is the in-app door, which
     * is what those tokens meant — and it keeps the 7 existing `app` contacts
     * in production correct rather than reclassifying them on next contact.
     */
    expect(acquisitionChannel({ walk_in: false })).toBe('app');
  });

  it('never invents the fourth combination', () => {
    /*
     * In the app without an account cannot happen: the app only issues a
     * session to somebody it has already authenticated. If a token ever claims
     * it anyway, `app` is the safe reading — it is the door we were told about,
     * and inventing a fourth channel for an impossible state would put a value
     * in the column that no report knows how to display.
     */
    expect(acquisitionChannel({ walk_in: true, entry_point: 'app' })).toBe('app');
  });

  it('only ever returns one of the three allowed values', () => {
    // The column is a choice list; a value outside it renders as a broken cell
    // in every report that groups by channel.
    const allowed = ['app', 'walk_in_app', 'walk_in'];
    for (const walk_in of [true, false, undefined]) {
      for (const entry_point of ['app', 'store_qr', undefined] as const) {
        expect(allowed).toContain(acquisitionChannel({ walk_in, entry_point }));
      }
    }
  });
});
