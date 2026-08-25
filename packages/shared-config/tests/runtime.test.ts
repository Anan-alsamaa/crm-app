import { describe, it, expect, afterEach } from 'vitest';
import { resolveUrl, resolveOptionalUrl, onPageHost } from '../src/runtime.js';

/*
 * THE RELEASE RULE RESTS ON THIS FILE.
 *
 * A Vite build inlines `import.meta.env.*`, so a URL baked in at build time
 * makes the bundle specific to one environment — and then staging proves
 * nothing about the artifact that ships, because the artifact that ships is a
 * different one. `resolveUrl` is what lets the SAME image serve staging and
 * production: the container writes /config.js at start-up and the portal reads
 * it in preference to whatever it was built with.
 *
 * Untested until now, while every portal URL already depended on it.
 */

type Injected = Record<string, string | undefined> | undefined;
function inject(cfg: Injected): void {
  (globalThis as { __SARA_CONFIG__?: Injected }).__SARA_CONFIG__ = cfg;
}

afterEach(() => {
  delete (globalThis as { __SARA_CONFIG__?: unknown }).__SARA_CONFIG__;
});

describe('resolveUrl — runtime beats build time', () => {
  it('prefers what the container injected', () => {
    inject({ DIRECTUS_URL: 'https://api.staging.example.com' });
    expect(
      resolveUrl('DIRECTUS_URL', 'https://api.prod.example.com', 'http://localhost:8055'),
    ).toBe('https://api.staging.example.com');
  });

  it('falls back to the build-time value, which is how local dev keeps working', () => {
    inject(undefined);
    expect(
      resolveUrl('DIRECTUS_URL', 'https://api.prod.example.com', 'http://localhost:8055'),
    ).toBe('https://api.prod.example.com');
  });

  it('falls back to the loopback default when neither is set', () => {
    inject(undefined);
    expect(resolveUrl('DIRECTUS_URL', undefined, 'http://localhost:8055')).toBe(
      'http://localhost:8055',
    );
  });

  it('treats an injected blank as absent rather than as a URL', () => {
    // The entrypoint omits unset variables, but a half-written config.js is the
    // kind of thing that happens once; an empty string must not win over a
    // perfectly good build-time value.
    inject({ DIRECTUS_URL: '   ' });
    expect(
      resolveUrl('DIRECTUS_URL', 'https://api.prod.example.com', 'http://localhost:8055'),
    ).toBe('https://api.prod.example.com');
  });

  it('resolves the job producer, which decides where a coupon push is enqueued', () => {
    // Baked, this had one environment's console enqueueing into another's queue.
    inject({ JOB_PRODUCER_URL: 'https://ws.staging.example.com' });
    expect(resolveUrl('JOB_PRODUCER_URL', undefined, 'http://localhost:3031')).toBe(
      'https://ws.staging.example.com',
    );
  });
});

describe('resolveOptionalUrl — absence stays absence', () => {
  /*
   * For settings where "not set" is a meaningful state. The compensation
   * Directus is the case: unset means "use the CRM client", so handing it a
   * loopback default would switch a feature ON and point it at nothing.
   */
  it('returns undefined when nothing is configured anywhere', () => {
    inject(undefined);
    expect(resolveOptionalUrl('COMPENSATION_DIRECTUS_URL', undefined)).toBeUndefined();
  });

  it('returns undefined for a blank rather than an empty string', () => {
    inject({ COMPENSATION_DIRECTUS_URL: '  ' });
    expect(resolveOptionalUrl('COMPENSATION_DIRECTUS_URL', '   ')).toBeUndefined();
  });

  it('still prefers the injected value when there is one', () => {
    inject({ COMPENSATION_DIRECTUS_URL: 'https://comp.example.com' });
    expect(resolveOptionalUrl('COMPENSATION_DIRECTUS_URL', 'https://built.example.com')).toBe(
      'https://comp.example.com',
    );
  });
});

describe('onPageHost — a loopback URL follows the page', () => {
  it('leaves a real hostname exactly as configured', () => {
    // A deployment names its API deliberately; rewriting that would be worse
    // than any convenience it bought.
    expect(onPageHost('https://api.example.com')).toBe('https://api.example.com');
  });

  it('does not throw on something that is not a URL at all', () => {
    expect(() => onPageHost('not a url')).not.toThrow();
  });
});
