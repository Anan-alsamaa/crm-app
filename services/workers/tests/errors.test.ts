import { describe, it, expect } from 'vitest';
import { describeError } from '../src/lib/errors.js';

/*
 * This exists because of one useless log line.
 *
 * A missing `svc-workers` permission on `coupon_approvals` — which made the
 * whole coupon feature incapable of working — reported itself as:
 *
 *   {"msg":"could not read undelivered coupons","err":"[object Object]"}
 *
 * The idiom behind that, `err instanceof Error ? err.message : String(err)`, is
 * used all over this service and is wrong for every Directus rejection, because
 * those are plain objects rather than Error instances.
 */
describe('describeError', () => {
  it('names the CODE in a Directus rejection, not "[object Object]"', () => {
    const directusError = {
      errors: [
        {
          message: "You don't have permission to access this.",
          extensions: { code: 'FORBIDDEN' },
        },
      ],
      response: { status: 403 },
    };
    const out = describeError(directusError);
    expect(out).toContain('FORBIDDEN');
    expect(out).toContain('403');
    expect(out).not.toContain('[object Object]');
  });

  it('joins several errors rather than reporting only the first', () => {
    const out = describeError({
      errors: [{ message: 'first thing' }, { message: 'second thing' }],
    });
    expect(out).toContain('first thing');
    expect(out).toContain('second thing');
  });

  it('still handles the ordinary cases', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ message: 'object with a message' })).toBe('object with a message');
  });

  it('falls back to the VALUE, never to its type name', () => {
    // The whole point: an unrecognised shape must still say what it was.
    expect(describeError({ weird: true })).toContain('weird');
    expect(describeError({ weird: true })).not.toContain('[object Object]');
  });

  it('survives something that cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});
