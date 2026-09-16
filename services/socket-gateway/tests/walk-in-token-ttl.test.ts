import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * THE WALK-IN TOKEN MUST OUTLIVE THE VISIT.
 *
 * It cannot be refreshed in place — the widget holds no signing secret, and a
 * QR walk-in has nothing to re-mint from either: the token was minted once
 * from a phone number typed into `/walk-in` and lives in that tab's
 * `sessionStorage`. So the TTL is the whole budget a customer gets, and when
 * it runs out mid-conversation they are stuck however well the widget behaves.
 *
 * Two hours hit real people: writing in at lunch and being answered that
 * afternoon is ordinary support, not an edge case.
 *
 * Asserted against the SOURCE rather than by minting a token, because the
 * route is defined inside `start()` behind Redis, Directus and a queue
 * producer — mocking all of that to observe one string would test the mocks.
 * This fails the moment somebody edits the value, which is the regression
 * worth catching.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

describe('walk-in token lifetime', () => {
  it('is twelve hours — long enough to cover a branch shift', () => {
    expect(SOURCE).toContain("expiresIn: '12h'");
  });

  it('is not the old two hours, which expired mid-conversation', () => {
    expect(SOURCE).not.toContain("expiresIn: '2h'");
  });
});
