import { describe, it, expect } from 'vitest';
import { isForbidden } from '../src/lib/directus.js';

/**
 * A REFUSAL IS NOT A RETRY (owner-reported, 2026-09-29).
 *
 * "Could not add the customer. Please try again." was shown for every failure,
 * including a 403 — advice that can never work, given to WeCare agents who then
 * retried for weeks while the real cause was a missing `contacts.create` grant.
 *
 * The shapes below are what the Directus SDK (17.x) actually rejects with:
 * a PLAIN OBJECT `{ errors, response }`, not an `Error`. So `err.message` is
 * undefined and `instanceof Error` is false — either assumption classifies
 * every refusal as an unknown failure, which is the bug this guards.
 */
describe('isForbidden', () => {
  /* The real thing, verified against staging: POST to a collection the token
     may not write answers 403 with `extensions.code === 'FORBIDDEN'`. */
  it('recognises the SDK rejection for a 403', () => {
    expect(
      isForbidden({
        errors: [
          {
            message: "You don't have permission to access this.",
            extensions: { code: 'FORBIDDEN' },
          },
        ],
        response: { status: 403 },
      }),
    ).toBe(true);
  });

  /* A 401 is also not something a retry fixes — the session is gone. */
  it('treats an expired session as a refusal', () => {
    expect(isForbidden({ response: { status: 401 } })).toBe(true);
  });

  /* Behind CloudFront a 403 can arrive with no parsed body, so the code alone
     has to be enough. */
  it('recognises the code without a response', () => {
    expect(isForbidden({ errors: [{ extensions: { code: 'FORBIDDEN' } }] })).toBe(true);
  });

  it('reads a status on the error itself', () => {
    expect(isForbidden({ status: 403 })).toBe(true);
  });

  /*
   * THESE MUST STAY "try again". A network blip, a 500 and a validation failure
   * are all things a second click or a fixed field can resolve; telling the
   * agent to find an administrator would send them down the wrong path.
   */
  it.each([
    ['a server error', { response: { status: 500 } }],
    ['a validation failure', { errors: [{ extensions: { code: 'FAILED_VALIDATION' } }] }],
    ['a plain Error from fetch', new Error('Failed to fetch')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
  ])('does not call %s a refusal', (_label, err) => {
    expect(isForbidden(err)).toBe(false);
  });

  /* Not an `Error`, and that is the point — nothing here may depend on it
     being one. */
  it('does not require the rejection to be an Error', () => {
    const rejection = { response: { status: 403 } };
    expect(rejection instanceof Error).toBe(false);
    expect(isForbidden(rejection)).toBe(true);
  });
});
